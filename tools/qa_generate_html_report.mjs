#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileExists, readJson, scoreKeys, severityRank } from './qa_lib.mjs';

const reportDir =
  process.env.QA_REPORT_DIR ?? 'docs/qa/reports/2026-05-09-ui-qa-pipeline';
const screenshotDir = process.env.QA_SCREENSHOT_DIR ?? join(reportDir, 'screenshots');
const matrixPath = process.env.QA_MATRIX_PATH ?? 'tools/qa_matrix.json';
const playthroughMatrixPath =
  process.env.QA_PLAYTHROUGH_MATRIX_PATH ?? 'tools/qa_playthrough_matrix.json';
const captureResultPath = process.env.QA_CAPTURE_RESULT_PATH ?? join(reportDir, 'capture_result.json');
const polishLintsPath = process.env.QA_POLISH_LINTS_PATH ?? join(reportDir, 'polish_lints.json');
const productReviewPath =
  process.env.QA_PRODUCT_REVIEW_PATH ?? join(reportDir, 'codex_product_review.json');
const playthroughReviewPath =
  process.env.QA_PLAYTHROUGH_REVIEW_PATH ?? join(reportDir, 'codex_playthrough_review.json');
const calibrationCandidatesPath =
  process.env.QA_CALIBRATION_CANDIDATES_PATH ?? join(reportDir, 'qa_calibration_candidates.json');
const calibrationProfilePath =
  process.env.QA_CALIBRATION_PROFILE_PATH ?? join(reportDir, 'qa_calibration_profile.json');
const fixedRulesPath = process.env.QA_FIXED_RULES_PATH ?? 'tools/qa_fixed_rules.json';
const liveStatusPath = process.env.QA_LIVE_STATUS_PATH ?? join(reportDir, 'qa_live_status.json');
const templatePath = process.env.QA_REPORT_TEMPLATE_PATH ?? 'tools/qa_report_template.html';
const outputPath = process.env.QA_HTML_REPORT_PATH ?? join(reportDir, 'report.html');
const calibrationOutputPath = process.env.QA_CALIBRATION_HTML_PATH ?? join(reportDir, 'calibration.html');
const qaMode = process.env.QA_MODE ?? 'full';
const dashboardUrl = process.env.QA_DASHBOARD_URL ?? 'http://127.0.0.1:64700';

const matrix = await readJson(matrixPath);
const playthroughMatrix = await readJson(playthroughMatrixPath);
const capture = await readJsonOrDefault(captureResultPath, {
  status: 'missing',
  expected_count: qaMode === 'full' ? matrix.screens.length : 0,
  captured_count: 0,
  results: [],
});
const lints = await readJsonOrDefault(polishLintsPath, {
  status: 'missing',
  summary: { pass: 0, low_confidence: 0, fail: 0 },
  results: [],
});
const review = await readJsonOrDefault(productReviewPath, {
  reviewed_by: null,
  status: 'not_entered',
  screens: [],
});
const playthroughReview = await readJsonOrDefault(playthroughReviewPath, {
  reviewed_by: null,
  status: 'not_entered',
  flows: [],
});
const calibrationCandidatesDoc = await readJsonOrDefault(calibrationCandidatesPath, {
  round: null,
  reply_guide: '캘리브레이션 후보가 아직 생성되지 않았습니다.',
  candidates: [],
});
const calibrationProfile = await readJsonOrDefault(calibrationProfilePath, {
  version: 2,
  accepted: [],
  rejected: [],
  needs_rewrite: {},
  deferred: {},
  notes: {},
  rewrites: {},
  learned_rules: {},
  priority_overrides: {},
});
const fixedRulesDoc = await readJsonOrDefault(fixedRulesPath, {
  version: 1,
  rules: [],
});
const liveStatus = (await fileExists(liveStatusPath))
  ? await readJson(liveStatusPath)
  : {
      status: 'not_started',
      phase: '대기',
      message: '아직 live QA 진행 상태가 기록되지 않았습니다.',
      updated_at: null,
      events: [],
    };

const lintById = new Map((lints.results ?? []).map((result) => [result.id, result]));
const reviewById = new Map((review.screens ?? []).map((result) => [result.id, result]));
const captureById = new Map((capture.results ?? []).map((result) => [result.id, result]));
const playthroughById = new Map((playthroughReview.flows ?? []).map((result) => [result.flow_id, result]));
const activeScreenIds = new Set((capture.results ?? []).map((result) => result.id));
const screenRows = matrix.screens
  .filter((screen) => qaMode !== 'fast' || activeScreenIds.has(screen.id))
  .map((screen) => screenRow(screen));
const flowRows = (playthroughMatrix.flows ?? []).map((flow) => flowRow(flow));
const calibrationCandidates = (calibrationCandidatesDoc.candidates ?? []).map((candidate) =>
  withProfileStatus(candidate),
);
const acceptedCalibrationCandidates = calibrationCandidates.filter(
  (candidate) => candidate.calibration_status === 'accepted',
);
const pendingCalibrationCandidates = calibrationCandidates.filter(
  (candidate) => candidate.calibration_status === 'pending',
);
const rewriteCalibrationCandidates = calibrationCandidates.filter(
  (candidate) => candidate.calibration_status === 'needs_rewrite',
);
const deferredCalibrationCandidates = calibrationCandidates.filter(
  (candidate) => candidate.calibration_status === 'deferred',
);
const rejectedCalibrationCandidates = calibrationCandidates.filter(
  (candidate) => candidate.calibration_status === 'rejected',
);
const severityCounts = countSeverity([...screenRows, ...flowRows]);
const contractCounts = countContractFindings(screenRows, flowRows);
const fixedRules = normalizeFixedRules(fixedRulesDoc);
const fixedRuleQueue = collectFixedRuleQueue();
const highRiskRows = screenRows.filter((row) => row.screen.mustReviewAtOriginalSize && row.finalVerdict !== 'PASS');
const narrativeRiskRows = flowRows.filter((row) => row.finalVerdict !== 'PASS');
const counts = {
  pass: screenRows.filter((row) => row.finalVerdict === 'PASS').length,
  fail: screenRows.filter((row) => row.finalVerdict === 'FAIL').length,
  low_confidence: screenRows.filter((row) => row.finalVerdict === 'LOW_CONFIDENCE').length,
};
const automatedGate = assessAutomatedGate();
const codexGate = assessCodexGate();
const finalPassEligible =
  qaMode === 'full' &&
  automatedGate.status === 'pass' &&
  codexGate.status === 'pass' &&
  counts.fail === 0 &&
  counts.low_confidence === 0 &&
  capture.captured_count === matrix.screens.length &&
  lints.summary?.fail === 0 &&
  review.status === 'pass' &&
  playthroughReview.status === 'pass' &&
  flowRows.every((row) => row.finalVerdict === 'PASS');
const finalStatus = finalPassEligible ? 'PASS' : qaMode === 'fast' ? '부분 검수 완료' : 'QA 미통과';

const payload = {
  generated_at: new Date().toISOString(),
  mode: qaMode,
  final_status: finalStatus,
  screen_counts: counts,
  severity_counts: severityCounts,
  contract_counts: contractCounts,
  high_risk_count: highRiskRows.length,
  narrative_risk_count: narrativeRiskRows.length,
  automated_gate: automatedGate,
  codex_gate: codexGate,
  calibration: {
    round: calibrationCandidatesDoc.round,
    candidate_count: calibrationCandidates.length,
    accepted_count: acceptedCalibrationCandidates.length,
    pending_count: pendingCalibrationCandidates.length,
    needs_rewrite_count: rewriteCalibrationCandidates.length,
    deferred_count: deferredCalibrationCandidates.length,
    rejected_count: rejectedCalibrationCandidates.length,
  },
  fixed_rules: {
    source: fixedRulesPath,
    rule_count: fixedRules.length,
    finding_count: fixedRuleQueue.length,
  },
  live_status: liveStatus,
};

const body = renderBody();
const template = await readFile(templatePath, 'utf8');
const html = template
  .replace('{{title}}', escapeHtml(`Dragonout QA Report - ${finalStatus}`))
  .replace('{{payload}}', escapeHtml(JSON.stringify(payload)))
  .replace('{{body}}', body);

await writeFile(outputPath, html);
console.log(`HTML QA report written to ${outputPath}`);

const calibrationBody = renderCalibrationSetupBody();
const calibrationHtml = template
  .replace('{{title}}', escapeHtml('Dragonout QA 허들 설정'))
  .replace('{{payload}}', escapeHtml(JSON.stringify({ ...payload, page: 'calibration_setup' })))
  .replace('{{body}}', calibrationBody);
await writeFile(calibrationOutputPath, calibrationHtml);
console.log(`Calibration setup written to ${calibrationOutputPath}`);

function screenRow(screen) {
  const lint = lintById.get(screen.id);
  const reviewed = reviewById.get(screen.id);
  const captured = captureById.get(screen.id);
  const scores = reviewed?.scores ?? {};
  const lowestScore = Math.min(...scoreKeys().map((key) => scores[key] ?? 0));
  const contract = assessScreenContract(screen, reviewed);
  const audit = buildScreenContractAudit(screen, reviewed);
  const severeFindings = [
    ...(lint?.findings ?? []),
    ...(reviewed?.findings ?? []),
  ].filter((finding) => severityRank(finding.severity) >= severityRank('P2'));
  const hardFail =
    contract.failures.length > 0 ||
    !captured ||
    !['captured', 'skipped_cached'].includes(captured.status) ||
    lint?.status === 'fail' ||
    reviewed?.status === 'fail' ||
    reviewed?.ship_readiness === 'needs_polish' ||
    reviewed?.ship_readiness === 'prototype_quality' ||
    lowestScore < 4 ||
    severeFindings.length > 0;
  const lowConfidence =
    contract.notObserved.length > 0 ||
    lint?.status === 'low_confidence' ||
    reviewed?.status === 'low_confidence' ||
    reviewed?.ship_readiness === 'evidence_missing';
  const finalVerdict =
    captured &&
    ['captured', 'skipped_cached'].includes(captured.status) &&
    contract.failures.length === 0 &&
    contract.notObserved.length === 0 &&
    lint?.status === 'pass' &&
    reviewed?.status === 'pass' &&
    reviewed?.ship_readiness === 'commercial_ready' &&
    lowestScore >= 4 &&
    severeFindings.length === 0
      ? 'PASS'
      : hardFail
        ? 'FAIL'
        : lowConfidence
        ? 'LOW_CONFIDENCE'
        : 'FAIL';
  const qaJudgementItems = ensureQaJudgementItems(buildQaJudgementItems({
    audit,
    findings: [...(reviewed?.findings ?? []), ...(lint?.findings ?? [])],
    fixedRules: reviewed?.fixed_rules ?? [],
    recommendedFix: reviewed?.recommended_fix ?? '',
  }), finalVerdict, {
    targetLabel: `${screen.screen} / ${screen.state}`,
    evidence: !captured
      ? `${screen.screenshot} 캡처가 현재 QA 산출물에서 확인되지 않습니다.`
      : `${screen.screen} 화면의 Codex 제품 검수 근거가 충분하지 않습니다.`,
    nextAction: !captured
      ? `${screen.screenshot}를 390x844 원본 크기로 다시 캡처하고 재검수하세요.`
      : '제품 검수 review_note, finding, 원본 캡처 확인 근거를 보강해 재검수하세요.',
  });
  return {
    screen,
    lint,
    reviewed,
    captured,
    lowestScore,
    severeFindings,
    contract,
    audit,
    qaJudgementItems,
    qaJudgementSummary: summarizeQaJudgementItems(qaJudgementItems),
    finalVerdict,
  };
}

function flowRow(flow) {
  const reviewed = playthroughById.get(flow.id);
  const scores = reviewed?.scenario_scores ?? {};
  const scoreValues = playthroughMatrix.requiredScoreKeys.map((key) => scores[key] ?? 0);
  const lowestScore = Math.min(...scoreValues);
  const contract = assessFlowContract(reviewed);
  const audit = buildFlowContractAudit(reviewed);
  const severeFindings = (reviewed?.findings ?? []).filter(
    (finding) => severityRank(finding.severity) >= severityRank('P2'),
  );
  const finalVerdict =
    contract.failures.length > 0
      ? 'FAIL'
      : contract.notObserved.length > 0
        ? 'LOW_CONFIDENCE'
        :
    reviewed?.verdict === 'pass' &&
    lowestScore >= 4 &&
    severeFindings.length === 0
      ? 'PASS'
      : reviewed?.verdict === 'low_confidence'
        ? 'LOW_CONFIDENCE'
        : 'FAIL';
  const qaJudgementItems = ensureQaJudgementItems(buildQaJudgementItems({
    audit,
    findings: reviewed?.findings ?? [],
    fixedRules: reviewed?.fixed_rules ?? [],
    recommendedFix: reviewed?.recommended_fix ?? '',
  }), finalVerdict, {
    targetLabel: flow.title,
    evidence: reviewed
      ? `${flow.title} 흐름의 판단 근거가 충분하지 않습니다.`
      : `${flow.title} 흐름의 Codex playthrough review가 현재 QA 산출물에 없습니다.`,
    nextAction: '실제 한국어 transcript와 CTA/선택/결과 연결 근거를 추가해 재검수하세요.',
  });
  return {
    flow,
    reviewed,
    lowestScore,
    severeFindings,
    contract,
    audit,
    qaJudgementItems,
    qaJudgementSummary: summarizeQaJudgementItems(qaJudgementItems),
    finalVerdict,
  };
}

function renderBody() {
  return `<header>
    <h1>Dragonout QA Report</h1>
    <p class="section-note">화면, 문구, 이벤트, 시나리오, 엔딩, UX를 함께 다루는 한글 QA 보고서입니다. Fast QA는 부분 검수이며 최종 PASS를 선언하지 않습니다.</p>
    <p class="section-note"><strong>읽기 전용 보고서:</strong> 이 HTML은 QA 산출물입니다. Fast QA / Full QA / Report 갱신 실행은 <a href="${escapeHtml(dashboardUrl)}">QA Dashboard</a>에서 진행합니다.</p>
    <div class="summary">
      ${summaryCard('최종 상태', finalStatus, finalStatus === 'PASS' ? 'pass' : finalStatus === '부분 검수 완료' ? 'low' : 'fail')}
      ${summaryCard('자동 게이트', automatedGate.label, automatedGate.tone)}
      ${summaryCard('Codex 검수', codexGate.label, codexGate.tone)}
      ${summaryCard('QA 모드', qaMode, qaMode === 'full' ? 'pass' : 'low')}
      ${summaryCard('캡처 수', `${capture.captured_count}/${capture.expected_count}`, capture.captured_count === capture.expected_count ? 'pass' : 'fail')}
      ${summaryCard('FAIL 화면', String(counts.fail), counts.fail === 0 ? 'pass' : 'fail')}
      ${summaryCard('LOW 화면', String(counts.low_confidence), counts.low_confidence === 0 ? 'pass' : 'low')}
      ${summaryCard('P0/P1/P2', `${severityCounts.P0}/${severityCounts.P1}/${severityCounts.P2}`, severityCounts.P0 + severityCounts.P1 + severityCounts.P2 === 0 ? 'pass' : 'fail')}
      ${summaryCard('FAIL 판정 항목', String(contractCounts.fail), contractCounts.fail === 0 ? 'pass' : 'fail')}
      ${summaryCard('QA 보강 필요', String(contractCounts.notObserved), contractCounts.notObserved === 0 ? 'pass' : 'low')}
      ${summaryCard('Playthrough', playthroughReview.status ?? 'missing', playthroughReview.status === 'pass' ? 'pass' : 'fail')}
      ${summaryCard('고정 QA 룰', String(fixedRules.length), fixedRules.length > 0 ? 'fail' : 'low')}
      ${summaryCard('룰 finding', String(fixedRuleQueue.length), fixedRuleQueue.length === 0 ? 'pass' : 'fail')}
    </div>
  </header>
  <main>
    <section>
      <h2>자동 검사 게이트</h2>
      <div class="summary">
        ${summaryCard('자동 검사', automatedGate.label, automatedGate.tone)}
        ${summaryCard('Codex 제품 검수', codexGate.label, codexGate.tone)}
        ${summaryCard('다음 액션', automatedGate.nextAction, automatedGate.tone)}
      </div>
      <p class="section-note">${escapeHtml(automatedGate.message)}</p>
      <p class="section-note">${escapeHtml(codexGate.message)}</p>
    </section>

    <section>
      <h2>실시간 진행 상태</h2>
      <div class="summary">
        ${summaryCard('상태', liveStatus.status ?? 'not_started', liveTone(liveStatus.status))}
        ${summaryCard('단계', liveStatus.phase ?? '대기', liveTone(liveStatus.status))}
        ${summaryCard('진행', liveProgressText(liveStatus), liveTone(liveStatus.status))}
        ${summaryCard('갱신', formatKst(liveStatus.updated_at), 'low')}
      </div>
      <p class="section-note">${escapeHtml(liveStatus.message ?? '')}</p>
      ${renderLiveEvents(liveStatus.events ?? [])}
    </section>

    <section>
      <h2>수정 큐</h2>
      <p class="section-note">수정 큐는 repo-tracked 고정 QA 룰이 현재 캡처/흐름에서 검출한 FAIL만 표시합니다. report별 profile 입력값은 이 큐를 직접 만들 수 없습니다.</p>
      <div class="queue priority-queue">
        ${renderRuleQueueCard('화면 고정 QA 룰 FAIL', fixedRuleQueue.filter((item) => item.type === 'screen_problem'))}
        ${renderRuleQueueCard('플레이 경험 고정 QA 룰 FAIL', fixedRuleQueue.filter((item) => item.type === 'play_experience'))}
        ${renderRuleQueueCard('전역 visual 고정 QA 룰 FAIL', fixedRuleQueue.filter((item) => item.type === 'global_visual'))}
      </div>
    </section>

    <section>
      <h2>Commercial Product QA Gate</h2>
      <p><strong>${finalStatus === 'PASS' ? '최종 상태: PASS' : finalStatus === '부분 검수 완료' ? '최종 상태: 부분 검수 완료' : '최종 상태: QA 미통과'}</strong></p>
      <p>${finalStatus === 'PASS' ? 'Codex visual/product review completed. Codex playthrough review completed. 모든 화면과 플레이 흐름이 commercial_ready입니다.' : `${codexGate.label}. 자동 검사 또는 Codex 제품 검수 단계에서 하나 이상의 화면 또는 흐름이 상업용 제품 QA 기준을 통과하지 못했거나 부분 검수입니다.`}</p>
    </section>

    <section>
      <h2>화면별 QA Matrix</h2>
      <div class="qa-matrix-grid">${screenRows.map(renderScreenRow).join('\n')}</div>
    </section>

    <section>
      <h2>Playthrough / Narrative QA</h2>
      <div class="qa-matrix-grid">${flowRows.map(renderFlowRow).join('\n')}</div>
    </section>

    <section>
      <h2>자동 검사 결과</h2>
      <div class="summary">
        ${summaryCard('Capture', `${capture.captured_count}/${capture.expected_count}`, capture.captured_count === capture.expected_count ? 'pass' : 'fail')}
        ${summaryCard('Polish Lint PASS 화면', String(lints.summary?.pass ?? 0), (lints.summary?.fail ?? 0) === 0 && (lints.summary?.pass ?? 0) > 0 ? 'pass' : 'low')}
        ${summaryCard('Polish Lint LOW 화면', String(lints.summary?.low_confidence ?? 0), (lints.summary?.low_confidence ?? 0) === 0 ? 'pass' : 'low')}
        ${summaryCard('Polish Lint FAIL', String(lints.summary?.fail ?? 0), (lints.summary?.fail ?? 0) === 0 ? 'pass' : 'fail')}
      </div>
    </section>
  </main>`;
}

function renderScreenRow(row) {
  const { screen, lint, reviewed, lowestScore, finalVerdict, qaJudgementItems, qaJudgementSummary } = row;
  const screenshotHref = relative(reportDir, join(screenshotDir, screen.screenshot));
  return `<article class="qa-card ${verdictTone(finalVerdict)}">
    <a class="qa-card-media" href="${escapeHtml(screenshotHref)}" target="_blank"><img class="thumb" src="${escapeHtml(screenshotHref)}" alt="${escapeHtml(screen.id)}"></a>
    <div class="qa-card-main">
      <div class="qa-card-head">
        <div>
          <h3>${escapeHtml(screen.screen)}</h3>
          <p class="muted">${escapeHtml(screen.state)} · ${escapeHtml(screen.id)}</p>
        </div>
        ${badge(finalVerdict)}
      </div>
      <div class="qa-card-meta">${badge(lint?.status ?? 'missing')} ${badge(reviewed?.ship_readiness ?? 'missing')} <span class="muted">최저점 ${escapeHtml(lowestScore)}</span></div>
      <div class="qa-card-columns">
        <div class="qa-card-section"><h4>점수</h4>${renderScores(reviewed?.scores ?? {}, lowestScore, scoreKeys())}</div>
        <div class="qa-card-section"><h4>판정 요약</h4>${renderJudgementSummary(qaJudgementSummary)}</div>
      </div>
      <div class="qa-card-section"><h4>QA 판정 항목</h4>${renderJudgementItems(qaJudgementItems)}</div>
      <div class="qa-card-columns">
        <div class="qa-card-section"><h4>자동 검사</h4>${renderFindings(lint?.findings ?? [])}</div>
        <div class="qa-card-section"><h4>Codex 제품 검수</h4><p>${escapeHtml(reviewed?.review_note ?? reviewed?.rationale ?? '')}</p>${renderFindings(reviewed?.findings ?? [])}</div>
      </div>
      <div class="qa-card-section"><h4>수정 후보</h4><p>${escapeHtml(reviewed?.recommended_fix ?? '')}</p></div>
    </div>
  </article>`;
}

function renderFlowRow(row) {
  const { flow, reviewed, lowestScore, finalVerdict, qaJudgementItems, qaJudgementSummary } = row;
  return `<article class="qa-card ${verdictTone(finalVerdict)}">
    <div class="qa-flow-thumb">Playthrough<br>${escapeHtml(flow.id)}</div>
    <div class="qa-card-main">
      <div class="qa-card-head">
        <div>
          <h3>${escapeHtml(flow.title)}</h3>
          <p class="muted">${escapeHtml(flow.id)}</p>
        </div>
        ${badge(finalVerdict)}
      </div>
      <div class="qa-card-section"><h4>흐름 단계</h4>${renderList(flow.steps ?? [])}</div>
      <div class="qa-card-columns">
        <div class="qa-card-section"><h4>점수</h4>${renderScores(reviewed?.scenario_scores ?? {}, lowestScore, playthroughMatrix.requiredScoreKeys)}</div>
        <div class="qa-card-section"><h4>판정 요약</h4>${renderJudgementSummary(qaJudgementSummary)}</div>
      </div>
      <div class="qa-card-section"><h4>QA 판정 항목</h4>${renderJudgementItems(qaJudgementItems)}</div>
      <div class="qa-card-columns">
        <div class="qa-card-section"><h4>Transcript</h4>${renderList(reviewed?.transcript ?? [])}</div>
        <div class="qa-card-section"><h4>Findings</h4>${renderFindings(reviewed?.findings ?? [])}</div>
      </div>
      <div class="qa-card-section"><h4>수정 후보</h4><p>${escapeHtml(reviewed?.recommended_fix ?? '')}</p></div>
    </div>
  </article>`;
}

function renderScores(scores, lowestScore, keys) {
  const rowsHtml = keys
    .map((key) => `<div class="score-row"><span>${scoreLabel(key)}</span><strong>${scores[key] ?? '-'}</strong></div>`)
    .join('');
  return `<div class="scores">${rowsHtml}<div class="score-row"><span>최저점</span><strong>${Number.isFinite(lowestScore) ? lowestScore : '-'}</strong></div></div>`;
}

function renderScreenContract(screen, reviewed) {
  const results = reviewed?.contract_results ?? {};
  return [
    renderContractGroup('기대해야 하는 항목', screen.expected ?? [], results.expected ?? []),
    renderContractGroup('현재 구현/관찰된 항목', screen.implementedEvidence ?? [], results.implementedEvidence ?? []),
    renderContractGroup('금지 항목', screen.forbidden ?? [], results.forbidden ?? []),
  ].join('');
}

function renderFlowContract(reviewed) {
  return [
    renderContractResultGroup('기대 흐름', reviewed?.expectedFlow ?? []),
    renderContractResultGroup('관찰된 흐름', reviewed?.observedFlow ?? []),
    renderContractResultGroup('금지 흐름 단절', reviewed?.forbiddenFlowBreaks ?? []),
  ].join('');
}

function renderContractGroup(title, contractItems, resultItems) {
  const resultById = new Map(resultItems.map((item) => [item.id, item]));
  const rows = contractItems.map((item) => resultById.get(item.id) ?? {
    id: item.id,
    label: item.label,
    status: 'not_observed',
    note: '검수 결과가 아직 기록되지 않았습니다.',
  });
  return renderContractResultGroup(title, rows);
}

function renderContractResultGroup(title, rows) {
  if (!rows || rows.length === 0) {
    return `<strong>${escapeHtml(title)}</strong><br><span class="muted">없음</span>`;
  }
  return `<details open><summary>${escapeHtml(title)}</summary><ul>${rows.map((row) => {
    const normalized = normalizeContractStatus(row.status);
    const tone = contractTone(normalized);
    const displayStatus = contractDisplayStatus(normalized, row.category);
    return `<li><span class="contract-badge ${tone}">${escapeHtml(displayStatus)}</span> ${escapeHtml(row.label ?? row.id)}<br><span class="muted">${escapeHtml(row.note ?? '')}</span></li>`;
  }).join('')}</ul></details>`;
}

function buildScreenContractAudit(screen, reviewed) {
  const results = reviewed?.contract_results ?? {};
  const rows = [
    ...contractRowsFromExpected('기대해야 하는 항목', 'expected', screen.expected ?? [], results.expected ?? []),
    ...contractRowsFromExpected('현재 구현/관찰된 항목', 'implementedEvidence', screen.implementedEvidence ?? [], results.implementedEvidence ?? []),
    ...contractRowsFromExpected('금지 항목', 'forbidden', screen.forbidden ?? [], results.forbidden ?? []),
  ];
  return { rows, summary: summarizeContractRows(rows) };
}

function buildFlowContractAudit(reviewed) {
  const rows = [
    ...(reviewed?.expectedFlow ?? []).map((row) => normalizeContractRow('기대 흐름', 'expectedFlow', row)),
    ...(reviewed?.observedFlow ?? []).map((row) => normalizeContractRow('관찰된 흐름', 'observedFlow', row)),
    ...(reviewed?.forbiddenFlowBreaks ?? []).map((row) => normalizeContractRow('금지 흐름 단절', 'forbiddenFlowBreaks', row)),
  ];
  return { rows, summary: summarizeContractRows(rows) };
}

function contractRowsFromExpected(groupTitle, category, contractItems, resultItems) {
  const resultById = new Map(resultItems.map((item) => [item.id, item]));
  return contractItems.map((item) => normalizeContractRow(groupTitle, category, resultById.get(item.id) ?? {
    id: item.id,
    label: item.label,
    status: 'not_observed',
    note: '검수 결과가 아직 기록되지 않았습니다.',
  }));
}

function normalizeContractRow(groupTitle, category, row) {
  const normalizedStatus = normalizeContractStatus(row.status);
  return {
    id: row.id ?? '',
    label: row.label ?? row.id ?? '계약 항목',
    category,
    groupTitle,
    status: normalizedStatus,
    displayStatus: contractDisplayStatus(normalizedStatus, category),
    reason: contractReason(row.status, category, row.note, row.label ?? row.id),
    note: row.note ?? '',
  };
}

function summarizeContractRows(rows) {
  return rows.reduce((summary, row) => {
    summary.total += 1;
    if (row.status === 'pass') summary.pass += 1;
    else if (row.status === 'evidence_gap') summary.evidenceGap += 1;
    else if (row.status === 'forbidden_absent') summary.forbiddenAbsent += 1;
    else if (row.status === 'forbidden_present') summary.forbiddenPresent += 1;
    else summary.fail += 1;
    return summary;
  }, { total: 0, pass: 0, fail: 0, evidenceGap: 0, forbiddenAbsent: 0, forbiddenPresent: 0 });
}

function renderContractAudit(audit) {
  const rows = audit?.rows ?? [];
  const summary = audit?.summary ?? summarizeContractRows([]);
  const failedRows = rows.filter((row) => ['fail', 'forbidden_present', 'evidence_gap'].includes(row.status));
  const passRows = rows.filter((row) => row.status === 'pass' || row.status === 'forbidden_absent');
  return `<div class="contract-summary">
    ${contractCount('PASS', summary.pass + summary.forbiddenAbsent, 'pass')}
    ${contractCount('FAIL', summary.fail + summary.forbiddenPresent, summary.fail + summary.forbiddenPresent > 0 ? 'fail' : 'pass')}
    ${contractCount('LOW_CONFIDENCE', summary.evidenceGap, summary.evidenceGap > 0 ? 'low' : 'pass')}
    ${contractCount('전체 기준', summary.total, 'pass')}
  </div>
  ${failedRows.length ? renderContractList(failedRows) : '<p class="pass">QA 판정 항목이 모두 PASS입니다.</p>'}
  <details><summary>전체 QA 판정 항목</summary>${renderContractList([...failedRows, ...passRows])}</details>`;
}

function buildQaJudgementItems({ audit, findings = [], fixedRules = [], recommendedFix = '' }) {
  const fixedRuleById = new Map(fixedRules.map((rule) => [rule.rule_id, rule]));
  const items = [];
  for (const finding of findings) {
    if (!finding.rule_id && severityRank(finding.severity) < severityRank('P2')) continue;
    const rule = fixedRuleById.get(finding.rule_id);
    items.push({
      key: finding.rule_id ? `rule:${finding.rule_id}` : `finding:${finding.code ?? finding.message ?? ''}`,
      status: 'FAIL',
      severity: finding.severity ?? rule?.severity ?? 'P2',
      criterionId: finding.rule_id ?? finding.code ?? 'review_finding',
      criterionName: rule?.assertion ?? finding.rule_id ?? finding.code ?? '제품 검수 finding',
      observedEvidence:
        finding.observed_evidence ??
        finding.message ??
        '현재 검수 finding이 남아 있어 FAIL입니다.',
      passCriteria:
        finding.pass_criteria ??
        rule?.pass_criteria ??
        '동일 finding이 재검수에서 재현되지 않아야 합니다.',
      nextAction:
        rule?.recommended_fix ??
        recommendedFix ??
        '해당 finding을 제거하도록 화면/문구/흐름을 수정하세요.',
    });
  }
  for (const row of audit?.rows ?? []) {
    items.push(contractRowToJudgementItem(row, recommendedFix));
  }
  return dedupeQaJudgementItems(items).sort((a, b) => {
    const rank = { FAIL: 0, LOW_CONFIDENCE: 1, PASS: 2 };
    const statusDelta = rank[a.status] - rank[b.status];
    if (statusDelta !== 0) return statusDelta;
    return severityRank(b.severity) - severityRank(a.severity);
  });
}

function ensureQaJudgementItems(items, verdict, fallback) {
  if (items.length > 0 || verdict === 'PASS') return items;
  const status = verdict === 'LOW_CONFIDENCE' ? 'LOW_CONFIDENCE' : 'FAIL';
  return [{
    key: `fallback:${fallback.targetLabel}`,
    status,
    severity: status === 'FAIL' ? 'P2' : 'P3',
    criterionId: 'qa_artifact_evidence',
    criterionName: `${fallback.targetLabel} QA 산출물 근거`,
    observedEvidence: fallback.evidence,
    passCriteria: `${fallback.targetLabel}의 원본 캡처, review finding, 또는 한국어 transcript 근거가 있어야 합니다.`,
    nextAction: fallback.nextAction,
  }];
}

function contractRowToJudgementItem(row, recommendedFix) {
  const status = contractJudgementStatus(row.status);
  return {
    key: `contract:${row.category}:${row.id || row.label}`,
    status,
    severity: status === 'FAIL' ? 'P2' : status === 'LOW_CONFIDENCE' ? 'P3' : '',
    criterionId: row.id,
    criterionName: row.label,
    observedEvidence: row.note || contractObservedEvidence(row, status),
    passCriteria: row.label,
    nextAction: judgementNextAction(status, recommendedFix, row.label),
  };
}

function contractJudgementStatus(status) {
  if (status === 'fail' || status === 'forbidden_present') return 'FAIL';
  if (status === 'evidence_gap') return 'LOW_CONFIDENCE';
  return 'PASS';
}

function contractObservedEvidence(row, status) {
  if (status === 'FAIL') return `${row.label} 기준이 현재 산출물에서 충족되지 않았습니다.`;
  if (status === 'LOW_CONFIDENCE') {
    return `${row.label} 기준을 판정할 원본 캡처, transcript, 동작 증거가 아직 충분하지 않습니다.`;
  }
  return `${row.label} 기준이 현재 산출물에서 확인됐습니다.`;
}

function judgementNextAction(status, recommendedFix, label) {
  if (status === 'FAIL') {
    return recommendedFix || `${label} 기준을 만족하도록 UI/문구/흐름을 수정하세요.`;
  }
  if (status === 'LOW_CONFIDENCE') {
    return `${label} 기준을 판정할 원본 크기 캡처, 상호작용 기록, 또는 한국어 transcript를 추가해 재검수하세요.`;
  }
  return '추가 조치 없음';
}

function dedupeQaJudgementItems(items) {
  const priority = { FAIL: 3, LOW_CONFIDENCE: 2, PASS: 1 };
  const byKey = new Map();
  for (const item of items) {
    const key = item.key || item.criterionId || item.criterionName;
    const existing = byKey.get(key);
    if (!existing || priority[item.status] > priority[existing.status]) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

function summarizeQaJudgementItems(items) {
  return items.reduce((summary, item) => {
    summary.total += 1;
    if (item.status === 'FAIL') summary.fail += 1;
    else if (item.status === 'LOW_CONFIDENCE') summary.low += 1;
    else summary.pass += 1;
    return summary;
  }, { total: 0, fail: 0, low: 0, pass: 0 });
}

function renderJudgementSummary(summary = { total: 0, fail: 0, low: 0, pass: 0 }) {
  return `<div class="contract-summary">
    ${contractCount('FAIL', summary.fail, summary.fail > 0 ? 'fail' : 'pass')}
    ${contractCount('LOW_CONFIDENCE', summary.low, summary.low > 0 ? 'low' : 'pass')}
    ${contractCount('PASS', summary.pass, 'pass')}
    ${contractCount('전체 기준', summary.total, 'pass')}
  </div>`;
}

function renderJudgementItems(items = []) {
  const visible = items.filter((item) => item.status !== 'PASS');
  const displayItems = visible.length ? visible : items.slice(0, 3);
  if (!displayItems.length) return '<p class="pass">QA 판정 항목이 모두 PASS입니다.</p>';
  const remaining = items.length > displayItems.length
    ? `<p class="muted">나머지 ${items.length - displayItems.length}개 PASS/상세 기준은 전체 QA 판정 항목에서 확인</p>`
    : '';
  return `<div class="qa-judgement-list">${displayItems.map(renderJudgementCard).join('')}${remaining}</div>
    <details><summary>전체 QA 판정 항목 (${items.length})</summary><ul>${items.map((item) => `<li>${renderJudgementLine(item)}</li>`).join('')}</ul></details>`;
}

function renderJudgementCard(item) {
  return `<article class="qa-judgement-card ${judgementTone(item.status)}">${renderJudgementLine(item)}</article>`;
}

function renderJudgementLine(item) {
  return `<div><span class="contract-badge ${judgementTone(item.status)}">${escapeHtml(item.status)}</span> ${escapeHtml(item.criterionName ?? item.criterionId ?? 'QA 기준')}</div>
    <div class="judgement-fields">
      <div><b>관찰 근거</b> ${escapeHtml(item.observedEvidence ?? '관찰 근거 미기록')}</div>
      <div><b>통과 기준</b> ${escapeHtml(item.passCriteria ?? '통과 기준 미기록')}</div>
      <div><b>다음 조치</b> ${escapeHtml(item.nextAction ?? '다음 조치 미기록')}</div>
    </div>`;
}

function judgementTone(status) {
  if (status === 'PASS') return 'pass';
  if (status === 'LOW_CONFIDENCE') return 'low';
  return 'fail';
}

function verdictTone(verdict) {
  if (verdict === 'PASS') return 'pass';
  if (verdict === 'LOW_CONFIDENCE') return 'low';
  return 'fail';
}

function contractCount(label, value, tone) {
  return `<span class="contract-count ${tone}"><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`;
}

function renderContractList(rows) {
  if (!rows.length) return '<span class="muted">없음</span>';
  return `<ul>${rows.map((row) => `<li>${contractStatusBadge(row)} ${escapeHtml(row.label)}<br><span class="muted">${escapeHtml(row.groupTitle)} · ${escapeHtml(row.reason)}</span></li>`).join('')}</ul>`;
}

function contractStatusBadge(row) {
  const tone = contractTone(row.status);
  return `<span class="contract-badge ${tone}">${escapeHtml(row.displayStatus)}</span>`;
}

function renderContractSummary(contract, audit) {
  const failures = contract?.failures ?? [];
  const notObserved = contract?.notObserved ?? [];
  const summary = audit?.summary;
  if (failures.length === 0 && notObserved.length === 0) {
    const countText = summary
      ? `PASS ${summary.pass + summary.forbiddenAbsent}, 전체 기준 ${summary.total}`
      : 'QA 판정 항목이 모두 PASS입니다.';
    return `<strong class="pass">QA 판정 PASS</strong><br><span class="muted">${escapeHtml(countText)}</span>`;
  }
  return `${failures.length > 0 ? `<strong class="fail">FAIL</strong>${renderList(failures)}` : ''}${notObserved.length > 0 ? `<strong class="low">LOW_CONFIDENCE</strong>${renderList(notObserved)}` : ''}`;
}

function normalizeContractStatus(status) {
  if (status === 'pass') return 'pass';
  if (status === 'absent') return 'forbidden_absent';
  if (status === 'present') return 'forbidden_present';
  if (status === 'not_observed') return 'evidence_gap';
  if (status === 'fail') return 'fail';
  return 'evidence_gap';
}

function contractDisplayStatus(status, category) {
  if (status === 'pass') return 'PASS';
  if (status === 'forbidden_absent') return 'PASS';
  if (status === 'forbidden_present') return 'FAIL';
  if (status === 'evidence_gap') return 'LOW_CONFIDENCE';
  return 'FAIL';
}

function contractReason(status, category, note, label = 'QA 기준') {
  if (note) return note;
  const normalized = normalizeContractStatus(status);
  if (normalized === 'pass' || normalized === 'forbidden_absent') return `PASS: ${label} 기준 확인`;
  if (normalized === 'forbidden_present') return `FAIL: ${label} 금지 조건이 현재 산출물에서 관찰됐습니다.`;
  if (normalized === 'evidence_gap') return `LOW_CONFIDENCE: ${label} 기준을 판정할 관찰 근거가 더 필요합니다.`;
  return `FAIL: ${label} 기준이 현재 산출물에서 충족되지 않았습니다.`;
}

function assessScreenContract(screen, reviewed) {
  const results = reviewed?.contract_results ?? {};
  const failures = [];
  const notObserved = [];
  const expectedResults = new Map((results.expected ?? []).map((item) => [item.id, item]));
  const evidenceResults = new Map((results.implementedEvidence ?? []).map((item) => [item.id, item]));
  const forbiddenResults = new Map((results.forbidden ?? []).map((item) => [item.id, item]));
  for (const id of screen.failIfMissing ?? []) {
    const result = expectedResults.get(id) ?? evidenceResults.get(id);
    if (!result || result.status === 'not_observed') {
      notObserved.push(`${id}: 필수 QA 판단 근거 필요`);
    } else if (result.status === 'fail') {
      failures.push(`${id}: 필수 계약 미충족`);
    }
  }
  for (const id of screen.failIfPresent ?? []) {
    const result = forbiddenResults.get(id);
    if (result?.status === 'present' || result?.status === 'fail') {
      failures.push(`${id}: 금지 항목 발견`);
    }
  }
  return { failures, notObserved };
}

function assessFlowContract(reviewed) {
  const failures = [];
  const notObserved = [];
  for (const group of ['expectedFlow', 'observedFlow', 'forbiddenFlowBreaks']) {
    for (const row of reviewed?.[group] ?? []) {
      if (row.status === 'fail' || row.status === 'present') {
        failures.push(`${row.id}: ${row.label ?? group}`);
      } else if (row.status === 'not_observed') {
        notObserved.push(`${row.id}: ${row.label ?? group}`);
      }
    }
  }
  return { failures, notObserved };
}

function renderFindings(findings) {
  if (!findings || findings.length === 0) {
    return '<span class="muted">근거 없음</span>';
  }
  return `<ul>${findings
    .map((finding) => `<li>${escapeHtml(finding.severity ?? '')} ${escapeHtml(finding.message ?? finding.note ?? '')}</li>`)
    .join('')}</ul>`;
}

function renderList(items) {
  if (!items || items.length === 0) return '<span class="muted">없음</span>';
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderQueueCard(title, items) {
  return `<div class="card"><h3>${escapeHtml(title)}</h3>${renderList(items.length ? items : ['현재 보고서 기준 없음'])}</div>`;
}

function renderRuleQueueCard(title, items) {
  if (!items.length) {
    return `<div class="card"><h3>${escapeHtml(title)}</h3><p class="muted">현재 고정 QA 룰 finding 없음</p></div>`;
  }
  return `<div class="card"><h3>${escapeHtml(title)}</h3><div class="rule-queue">${items.map(renderRuleQueueItem).join('\n')}</div></div>`;
}

function renderRuleQueueItem(item) {
  return `<article class="rule-finding">
    <div class="rule-finding-head">
      <strong>${escapeHtml(item.rule_id)}</strong>
      ${badge(item.severity)}
    </div>
    <p><span class="muted">대상:</span> ${escapeHtml(item.target_label)} <code>${escapeHtml(item.target_id)}</code></p>
    <p><span class="muted">검출 근거:</span> ${escapeHtml(item.observed_evidence)}</p>
    <p><span class="muted">통과 기준:</span> ${escapeHtml(item.pass_criteria)}</p>
    <p><span class="muted">수정 방향:</span> ${escapeHtml(item.recommended_fix ?? '')}</p>
  </article>`;
}

function collectFixedRuleQueue() {
  const items = [];
  for (const row of screenRows) {
    const rules = Array.isArray(row.reviewed?.fixed_rules) ? row.reviewed.fixed_rules : [];
    for (const rule of rules) {
      const finding = (row.reviewed?.findings ?? []).find((item) => item.rule_id === rule.rule_id);
      items.push(ruleQueueItem('screen_problem', `${row.screen.screen} / ${row.screen.state}`, rule, finding));
    }
  }
  for (const row of flowRows) {
    const rules = Array.isArray(row.reviewed?.fixed_rules) ? row.reviewed.fixed_rules : [];
    for (const rule of rules) {
      const finding = (row.reviewed?.findings ?? []).find((item) => item.rule_id === rule.rule_id);
      items.push(ruleQueueItem('play_experience', row.flow.title, rule, finding));
    }
  }
  for (const finding of review.global_visual_findings ?? []) {
    const rule = fixedRules.find((item) => item.rule_id === finding.rule_id) ?? finding;
    items.push(ruleQueueItem('global_visual', globalTargetLabel(rule.target_id), rule, finding));
  }
  return items;
}

function ruleQueueItem(type, targetLabel, rule, finding) {
  return {
    type,
    rule_id: rule.rule_id ?? finding?.rule_id ?? '',
    target_id: rule.target_id ?? finding?.target_id ?? '',
    target_label: targetLabel,
    severity: finding?.severity ?? rule.severity ?? 'P1',
    observed_evidence: finding?.observed_evidence ?? rule.observed_evidence ?? finding?.message ?? '',
    pass_criteria: finding?.pass_criteria ?? rule.pass_criteria ?? '',
    recommended_fix: rule.recommended_fix ?? '',
  };
}

function renderCalibrationSetupBody() {
  return `<header>
    <h1>Dragonout QA 허들 설정</h1>
    <p class="section-note">이 화면은 일반 QA report가 아니라, 사용자 피드백을 고정 QA 룰 draft로 승격할 때만 확인하는 setup 산출물입니다.</p>
    <div class="summary">
      ${summaryCard('후보 수', String(calibrationCandidates.length), calibrationCandidates.length > 0 ? 'low' : 'fail')}
      ${summaryCard('고정 룰 수', String(fixedRules.length), fixedRules.length > 0 ? 'pass' : 'low')}
      ${summaryCard('현재 검출 finding', String(fixedRuleQueue.length), fixedRuleQueue.length > 0 ? 'fail' : 'pass')}
      ${summaryCard('CAL-S02 룰', String(fixedRules.filter((rule) => rule.source_candidate_id === 'CAL-S02').length), 'fail')}
    </div>
  </header>
  <main>
    <section>
      <h2>허들 설정 후보</h2>
      <p class="section-note">각 후보는 “후보 → 룰 draft → 현재 검출 결과 → 고정/재작성/기각” 순서로 확인합니다. 고정된 룰만 normal report의 수정 큐를 만들 수 있습니다.</p>
      <div class="calibration-form">
        ${calibrationCandidates.map(renderCalibrationSetupCard).join('\n')}
      </div>
    </section>
  </main>`;
}

function renderCalibrationSetupCard(candidate) {
  const candidateRules = fixedRules.filter((rule) => rule.source_candidate_id === candidate.candidate_id);
  const detectedRules = fixedRuleQueue.filter((item) =>
    candidateRules.some((rule) => rule.rule_id === item.rule_id),
  );
  const targetHtml = candidate.type === 'screen_problem'
    ? renderCandidateScreenshot(candidate)
    : `${escapeHtml(candidate.target_label ?? candidate.target_id)}<br>${renderList(candidate.flow_steps ?? [])}`;
  return `<article class="calibration-card" data-candidate-id="${escapeHtml(candidate.candidate_id)}">
    <div class="calibration-head">
      <div>
        <strong>${escapeHtml(candidate.candidate_id)}</strong>
        <h3>${escapeHtml(candidate.title ?? '')}</h3>
        <p class="muted">${escapeHtml(candidate.type ?? '')} · ${escapeHtml(candidate.target_label ?? candidate.target_id ?? '')}</p>
      </div>
      <div>${badge(calibrationStatusLabel(candidate.calibration_status))}<br><span class="muted">${escapeHtml(candidate.priority ?? candidate.proposed_priority ?? '')} · ${escapeHtml(candidate.confidence ?? '')}</span></div>
    </div>
    <div class="calibration-grid">
      <div class="calibration-target">${targetHtml}</div>
      <div>
        <h4>사용자 피드백에서 나온 후보</h4>
        <p>${escapeHtml(candidate.problem_claim ?? '')}</p>
        <h4>룰 draft</h4>
        ${renderFixedRuleDrafts(candidateRules)}
        <h4>현재 캡처/흐름 검출 결과</h4>
        ${detectedRules.length ? `<div class="rule-queue">${detectedRules.map(renderRuleQueueItem).join('\n')}</div>` : '<p class="muted">현재 report에서 이 후보의 고정 룰 finding이 없습니다.</p>'}
        <h4>허들 설정 선택지</h4>
        <fieldset class="calibration-options">
          <legend>${escapeHtml(candidate.candidate_id)} 룰 처리</legend>
          <label><input type="radio" name="setup-${escapeHtml(candidate.candidate_id)}" value="freeze"> 고정</label>
          <label><input type="radio" name="setup-${escapeHtml(candidate.candidate_id)}" value="rewrite"> 재작성</label>
          <label><input type="radio" name="setup-${escapeHtml(candidate.candidate_id)}" value="reject"> 기각</label>
        </fieldset>
      </div>
    </div>
  </article>`;
}

function renderFixedRuleDrafts(rules) {
  if (!rules.length) return '<p class="muted">아직 repo-tracked 고정 룰이 없습니다.</p>';
  return `<ul>${rules.map((rule) => `<li><strong>${escapeHtml(rule.rule_id)}</strong>: ${escapeHtml(rule.assertion)}<br><span class="muted">검출 근거: ${escapeHtml(rule.observed_evidence)} / 통과 기준: ${escapeHtml(rule.pass_criteria)}</span></li>`).join('')}</ul>`;
}

function renderCalibrationCandidateCard(candidate) {
  const targetHtml = candidate.type === 'screen_problem'
    ? renderCandidateScreenshot(candidate)
    : `${escapeHtml(candidate.target_label ?? candidate.target_id)}<br>${renderList(candidate.flow_steps ?? [])}`;
  const status = candidate.calibration_status ?? 'pending';
  return `<article class="calibration-card" data-candidate-id="${escapeHtml(candidate.candidate_id)}" data-candidate-type="${escapeHtml(candidate.type ?? '')}">
    <div class="calibration-head">
      <div>
        <strong>${escapeHtml(candidate.candidate_id)}</strong>
        <h3>${escapeHtml(candidate.title ?? '')}</h3>
        <p class="muted">${escapeHtml(candidate.type ?? '')} · ${escapeHtml(candidate.target_label ?? candidate.target_id ?? '')}</p>
      </div>
      <div>${badge(calibrationStatusLabel(status))}<br><span class="muted">${escapeHtml(candidate.priority ?? candidate.proposed_priority ?? '')} · ${escapeHtml(candidate.confidence ?? '')}</span></div>
    </div>
    <div class="calibration-grid">
      <div class="calibration-target">${targetHtml}</div>
      <div>
        <h4>관찰 근거</h4>
        <p>${escapeHtml(candidate.evidence ?? '')}</p>
        <h4>문제 후보</h4>
        <p>${escapeHtml(candidate.problem_claim ?? '')}</p>
        <h4>수정 방향</h4>
        <p>${escapeHtml(candidate.suggested_fix ?? '')}</p>
        <h4>학습된 QA 규칙</h4>
        ${renderLearnedRules(candidate.learned_rules ?? [])}
        <h4>답변 템플릿</h4>
        <p><code>${escapeHtml(candidate.answer_template ?? `${candidate.candidate_id} OK / ${candidate.candidate_id} 아님 / ${candidate.candidate_id} 수정: ...`)}</code></p>
      </div>
    </div>
    <fieldset class="calibration-options">
      <legend>판정</legend>
      ${renderStatusRadio(candidate, 'accepted', '수용')}
      ${renderStatusRadio(candidate, 'rejected', '기각')}
      ${renderStatusRadio(candidate, 'needs_rewrite', '수정 필요')}
      ${renderStatusRadio(candidate, 'deferred', '나중에')}
    </fieldset>
    <label class="calibration-field">메모
      <textarea data-calibration-field="note" rows="3">${escapeHtml(noteForCandidate(candidate.candidate_id))}</textarea>
    </label>
    <div class="calibration-rewrite-grid">
      <label class="calibration-field">문제 재작성
        <textarea data-calibration-field="rewrite_problem_claim" rows="3">${escapeHtml(rewriteField(candidate.candidate_id, 'problem_claim'))}</textarea>
      </label>
      <label class="calibration-field">수정 방향 재작성
        <textarea data-calibration-field="rewrite_suggested_fix" rows="3">${escapeHtml(rewriteField(candidate.candidate_id, 'suggested_fix'))}</textarea>
      </label>
    </div>
    <label class="calibration-field calibration-priority">우선순위
      <select data-calibration-field="priority">
        ${['', 'P0', 'P1', 'P2', 'P3'].map((priority) => `<option value="${priority}"${priority === (calibrationProfile.priority_overrides?.[candidate.candidate_id] ?? '') ? ' selected' : ''}>${priority || '기본값 유지'}</option>`).join('')}
      </select>
    </label>
  </article>`;
}

function renderStatusRadio(candidate, status, label) {
  const checked = candidate.calibration_status === status ? ' checked' : '';
  return `<label><input type="radio" name="calibration-${escapeHtml(candidate.candidate_id)}" value="${escapeHtml(status)}"${checked}> ${escapeHtml(label)}</label>`;
}

function noteForCandidate(candidateId) {
  return (
    calibrationProfile.notes?.[candidateId] ??
    calibrationProfile.needs_rewrite?.[candidateId] ??
    calibrationProfile.deferred?.[candidateId] ??
    ''
  );
}

function rewriteField(candidateId, field) {
  const rewrite = calibrationProfile.rewrites?.[candidateId];
  if (!rewrite || typeof rewrite !== 'object') return '';
  return typeof rewrite[field] === 'string' ? rewrite[field] : '';
}

function renderCalibrationFormScript() {
  const initialProfile = {
    version: 2,
    round: calibrationCandidatesDoc.round ?? null,
    accepted: calibrationProfile.accepted ?? [],
    rejected: calibrationProfile.rejected ?? [],
    needs_rewrite: calibrationProfile.needs_rewrite ?? {},
    deferred: calibrationProfile.deferred ?? {},
    notes: calibrationProfile.notes ?? {},
    rewrites: calibrationProfile.rewrites ?? {},
    learned_rules: calibrationProfile.learned_rules ?? {},
    priority_overrides: calibrationProfile.priority_overrides ?? {},
  };
  return `<script>
(() => {
  const initialProfile = ${JSON.stringify(initialProfile)};
  const form = document.getElementById('calibrationForm');
  const saveButton = document.getElementById('calibrationSaveButton');
  const copyButton = document.getElementById('calibrationCopyButton');
  const output = document.getElementById('calibrationProfileJson');
  const statusEl = document.getElementById('calibrationSaveStatus');
  const statusLabels = { accepted: '수용', rejected: '기각', needs_rewrite: '수정 필요', deferred: '나중에' };

  function readProfileFromForm() {
    const profile = {
      version: 2,
      round: initialProfile.round,
      updated_at: new Date().toISOString(),
      accepted: [],
      rejected: [],
      needs_rewrite: {},
      deferred: {},
      notes: {},
      rewrites: {},
      learned_rules: initialProfile.learned_rules || {},
      priority_overrides: {},
    };
    for (const card of form.querySelectorAll('.calibration-card')) {
      const id = card.dataset.candidateId;
      const status = card.querySelector('input[type="radio"]:checked')?.value;
      const note = card.querySelector('[data-calibration-field="note"]')?.value.trim() ?? '';
      const rewriteProblem = card.querySelector('[data-calibration-field="rewrite_problem_claim"]')?.value.trim() ?? '';
      const rewriteFix = card.querySelector('[data-calibration-field="rewrite_suggested_fix"]')?.value.trim() ?? '';
      const priority = card.querySelector('[data-calibration-field="priority"]')?.value ?? '';
      if (status === 'accepted') profile.accepted.push(id);
      if (status === 'rejected') profile.rejected.push(id);
      if (status === 'needs_rewrite') profile.needs_rewrite[id] = note || statusLabels[status];
      if (status === 'deferred') profile.deferred[id] = note || statusLabels[status];
      if (note) profile.notes[id] = note;
      if (rewriteProblem || rewriteFix) {
        profile.rewrites[id] = {};
        if (rewriteProblem) profile.rewrites[id].problem_claim = rewriteProblem;
        if (rewriteFix) profile.rewrites[id].suggested_fix = rewriteFix;
      }
      if (priority) profile.priority_overrides[id] = priority;
    }
    return profile;
  }

  function renderProfile() {
    const profile = readProfileFromForm();
    output.value = JSON.stringify(profile, null, 2);
    return profile;
  }

  async function copyProfile() {
    const profile = renderProfile();
    const text = JSON.stringify(profile, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = 'profile JSON을 클립보드에 복사했습니다.';
    } catch {
      output.focus();
      output.select();
      statusEl.textContent = '클립보드 복사가 막혀 JSON textarea를 선택했습니다.';
    }
  }

  async function saveProfile() {
    const profile = renderProfile();
    if (location.protocol === 'file:') {
      await copyProfile();
      statusEl.textContent = 'file:// 리포트는 직접 저장할 수 없어 profile JSON을 복사했습니다.';
      return;
    }
    saveButton.disabled = true;
    statusEl.textContent = '저장 중...';
    try {
      const response = await fetch('/api/calibration-profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(profile),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '저장 실패');
      statusEl.textContent = '저장했습니다. 새 profile로 리포트를 갱신했습니다.';
      window.setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      statusEl.textContent = '저장 실패: ' + (error instanceof Error ? error.message : String(error));
    } finally {
      saveButton.disabled = false;
    }
  }

  form.addEventListener('change', renderProfile);
  form.addEventListener('input', renderProfile);
  copyButton.addEventListener('click', copyProfile);
  saveButton.addEventListener('click', saveProfile);
  renderProfile();
})();
</script>`;
}

function renderCandidateScreenshot(candidate) {
  if (!candidate.screenshot) {
    return escapeHtml(candidate.target_label ?? candidate.target_id ?? '');
  }
  return `<a href="${escapeHtml(candidate.screenshot)}" target="_blank"><img class="thumb" src="${escapeHtml(candidate.screenshot)}" alt="${escapeHtml(candidate.candidate_id)}"></a><br><span class="muted">${escapeHtml(candidate.target_label ?? candidate.target_id)}</span>`;
}

function acceptedCalibrationQueue(type) {
  return acceptedCalibrationCandidates
    .filter((candidate) => candidate.type === type)
    .map((candidate) => {
      const rules = (candidate.learned_rules ?? [])
        .map((rule) => `${rule.rule_id} 통과 기준: ${rule.pass_criteria}`)
        .join(' / ');
      return `${candidate.candidate_id} ${candidate.target_label}: ${candidate.suggested_fix}${rules ? ` (${rules})` : ' (학습된 QA 규칙 없음)'}`;
    });
}

function candidateSummary(candidate) {
  return `${candidate.candidate_id} ${candidate.target_label}: ${candidate.problem_claim}`;
}

function withProfileStatus(candidate) {
  const status = calibrationStatusForCandidate(candidate.candidate_id);
  const rewrite = rewriteForCandidate(candidate.candidate_id);
  const learnedRules = learnedRulesForCandidate(candidate.candidate_id, {
    ...candidate,
    ...rewrite,
  });
  return {
    ...candidate,
    ...rewrite,
    calibration_status: status,
    priority: calibrationProfile.priority_overrides?.[candidate.candidate_id] ?? candidate.priority ?? candidate.proposed_priority,
    calibration_note: noteForCandidate(candidate.candidate_id),
    learned_rules: learnedRules,
    rewrite,
  };
}

function normalizeFixedRules(doc) {
  const rules = Array.isArray(doc?.rules) ? doc.rules : [];
  return rules
    .map((rule) => ({
      rule_id: String(rule.rule_id ?? '').trim(),
      source_candidate_id: String(rule.source_candidate_id ?? '').trim(),
      type: String(rule.type ?? '').trim(),
      target_id: String(rule.target_id ?? '').trim(),
      assertion: String(rule.assertion ?? '').trim(),
      observed_evidence: String(rule.observed_evidence ?? '').trim(),
      pass_criteria: String(rule.pass_criteria ?? '').trim(),
      recommended_fix: String(rule.recommended_fix ?? '').trim(),
      severity: String(rule.severity ?? 'P1').trim(),
    }))
    .filter((rule) => rule.rule_id && rule.target_id && rule.type);
}

function globalTargetLabel(targetId) {
  return {
    global_visual_chrome: '전역 HUD/박스 장식',
  }[targetId] ?? targetId ?? '전역 visual';
}

function calibrationStatusForCandidate(candidateId) {
  if (arraySet(calibrationProfile.accepted).has(candidateId)) return 'accepted';
  if (arraySet(calibrationProfile.rejected).has(candidateId)) return 'rejected';
  if (needsRewriteSet().has(candidateId)) return 'needs_rewrite';
  if (deferredSet().has(candidateId)) return 'deferred';
  return 'pending';
}

function calibrationStatusLabel(status) {
  return {
    accepted: 'accepted',
    rejected: 'rejected',
    needs_rewrite: 'needs_rewrite',
    deferred: 'deferred',
    pending: 'pending',
  }[status] ?? status ?? 'pending';
}

function renderLiveEvents(events) {
  if (!events || events.length === 0) {
    return '<p class="section-note">아직 단계별 이벤트가 없습니다.</p>';
  }
  const recentEvents = events.slice(-12).reverse();
  return `<table>
    <thead><tr><th>시간</th><th>단계</th><th>상태</th><th>메시지</th></tr></thead>
    <tbody>${recentEvents.map((event) => `<tr>
      <td>${escapeHtml(formatKst(event.at))}</td>
      <td>${escapeHtml(event.phase ?? '')}</td>
      <td>${badge(event.status ?? '')}</td>
      <td>${escapeHtml(event.message ?? '')}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function liveProgressText(liveStatus) {
  const current = Number(liveStatus.current ?? 0);
  const total = Number(liveStatus.total ?? 0);
  if (total > 0) return `${current}/${total}`;
  return '단계형 진행';
}

function liveTone(status) {
  if (status === 'complete') return 'pass';
  if (status === 'failed') return 'fail';
  if (status === 'running') return 'low';
  return 'low';
}

function assessAutomatedGate() {
  const reasons = [];
  if (capture.status === 'missing' || !Array.isArray(capture.results)) {
    reasons.push('capture_result.json이 아직 없습니다.');
  }
  if (lints.status === 'missing' || !Array.isArray(lints.results)) {
    reasons.push('polish_lints.json이 아직 없습니다.');
  }
  const failedCaptures = (capture.results ?? []).filter((result) => !['captured', 'skipped_cached'].includes(result.status));
  if (failedCaptures.length > 0) {
    reasons.push(`캡처 실패 ${failedCaptures.length}건`);
  }
  const p2Plus = (lints.results ?? []).flatMap((result) =>
    (result.findings ?? [])
      .filter((finding) => severityRank(finding.severity) >= severityRank('P2'))
      .map((finding) => `${result.id}:${finding.severity}:${finding.code ?? 'finding'}`),
  );
  if ((lints.summary?.fail ?? 0) > 0 || p2Plus.length > 0) {
    reasons.push(`P2+ 자동 finding ${p2Plus.length}건`);
  }
  if (reasons.length > 0) {
    return {
      status: p2Plus.length > 0 || failedCaptures.length > 0 ? 'fail' : 'not_run',
      label: p2Plus.length > 0 || failedCaptures.length > 0 ? '자동 검사 FAIL' : '자동 검사 미완료',
      tone: p2Plus.length > 0 || failedCaptures.length > 0 ? 'fail' : 'low',
      message: reasons.join(' '),
      nextAction: p2Plus.length > 0 || failedCaptures.length > 0 ? '자동 실패 수정 후 재실행' : 'capture/lint 실행',
    };
  }
  return {
    status: 'pass',
    label: '자동 검사 PASS',
    tone: 'pass',
    message: 'P0/P1/P2 자동 finding 없이 Codex 제품 검수 진입이 가능합니다.',
    nextAction: 'Codex 제품 검수 진입',
  };
}

function assessCodexGate() {
  if (automatedGate.status !== 'pass') {
    return {
      status: 'not_entered',
      label: 'Codex 제품 검수 미진입',
      tone: 'low',
      message: '자동 검사 게이트가 통과되지 않아 Codex 제품 검수 대상으로 승격하지 않습니다.',
    };
  }
  if (review.status === 'pass' && playthroughReview.status === 'pass') {
    return {
      status: 'pass',
      label: 'Codex 제품 검수 PASS',
      tone: 'pass',
      message: 'Codex product/playthrough review가 모두 통과했습니다.',
    };
  }
  if (review.status === 'fail' || playthroughReview.status === 'fail') {
    return {
      status: 'fail',
      label: 'Codex 제품 검수 FAIL',
      tone: 'fail',
      message: 'Codex product/playthrough review가 실패 상태입니다. 수정 큐를 먼저 처리해야 합니다.',
    };
  }
  if (String(review.status).startsWith('calibration') || String(playthroughReview.status).startsWith('calibration')) {
    return {
      status: 'calibration_pending',
      label: '캘리브레이션 대기',
      tone: 'low',
      message: '사용자 accepted 후보가 아직 없어 개발 큐를 확정하지 않았습니다.',
    };
  }
  return {
    status: 'ready',
    label: 'Codex 제품 검수 ready',
    tone: 'low',
    message: '자동 검사는 통과했으며 Codex product/playthrough review 작성 또는 갱신이 필요합니다.',
  };
}

function userRegressionQueue() {
  return ['start', 'base_status', 'guardian_dialog', 'location_dialog', 'outing']
    .map((id) => screenRows.find((row) => row.screen.id === id))
    .filter(Boolean)
    .map((row) => `${row.screen.screenshot}: ${row.finalVerdict}`);
}

function forbiddenViolationQueue() {
  return screenRows
    .flatMap((row) => row.contract.failures.filter((failure) => failure.includes('금지 항목')).map((failure) => `${row.screen.id}: ${failure}`))
    .slice(0, 24);
}

function evidenceGapQueue() {
  return screenRows
    .flatMap((row) => row.contract.notObserved.map((gap) => `${row.screen.id}: ${gap}`))
    .slice(0, 24);
}

function arraySet(value) {
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

function needsRewriteSet() {
  if (Array.isArray(calibrationProfile.needs_rewrite)) return arraySet(calibrationProfile.needs_rewrite);
  return new Set(Object.keys(calibrationProfile.needs_rewrite ?? {}));
}

function deferredSet() {
  if (Array.isArray(calibrationProfile.deferred)) return arraySet(calibrationProfile.deferred);
  return new Set(Object.keys(calibrationProfile.deferred ?? {}));
}

function rewriteForCandidate(candidateId) {
  const rewrite = calibrationProfile.rewrites?.[candidateId];
  if (!rewrite || typeof rewrite !== 'object' || Array.isArray(rewrite)) return {};
  const fields = {};
  for (const field of ['title', 'evidence', 'problem_claim', 'suggested_fix']) {
    if (typeof rewrite[field] === 'string' && rewrite[field].trim()) {
      fields[field] = rewrite[field].trim();
    }
  }
  return fields;
}

function learnedRulesForCandidate(candidateId, candidate) {
  const profileRules = calibrationProfile.learned_rules?.[candidateId];
  const candidateRules = candidate.learned_rules;
  const rules = Array.isArray(profileRules) ? profileRules : Array.isArray(candidateRules) ? candidateRules : [];
  return rules
    .map((rule, index) => normalizeLearnedRule(rule, candidateId, candidate, index))
    .filter(Boolean);
}

function normalizeLearnedRule(rule, candidateId, candidate, index) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const ruleId = typeof rule.rule_id === 'string' && rule.rule_id.trim()
    ? rule.rule_id.trim()
    : `${candidateId.toLowerCase()}_rule_${index + 1}`;
  return {
    rule_id: ruleId,
    assertion: textOrFallback(rule.assertion, candidate.problem_claim),
    current_observation: textOrFallback(rule.current_observation, candidate.evidence),
    pass_criteria: textOrFallback(rule.pass_criteria, candidate.suggested_fix),
    severity: textOrFallback(rule.severity, candidate.priority ?? candidate.proposed_priority ?? 'P1'),
  };
}

function renderLearnedRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return '<p class="muted">accepted 후보가 개발 큐에 들어가려면 학습된 QA 규칙이 필요합니다.</p>';
  }
  return `<ul>${rules.map((rule) => `<li><strong>${escapeHtml(rule.rule_id)}</strong>: ${escapeHtml(rule.assertion)}<br><span class="muted">현재 근거: ${escapeHtml(rule.current_observation)} / 통과 기준: ${escapeHtml(rule.pass_criteria)}</span></li>`).join('')}</ul>`;
}

function textOrFallback(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : String(fallback ?? '').trim();
}

function summaryCard(label, value, tone) {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value ${escapeHtml(tone)}">${escapeHtml(value)}</div></div>`;
}

function formatKst(value) {
  if (!value) return '기록 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)} KST`;
}

function badge(value) {
  const text = String(value);
  const lower = text.toLowerCase();
  const tone = lower.includes('pass') || lower.includes('ready') || lower.includes('완료') || lower.includes('accepted')
    ? 'pass'
    : lower.includes('low') || lower.includes('부분') || lower.includes('not_observed') || lower.includes('pending') || lower.includes('needs_rewrite')
      ? 'low'
      : 'fail';
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

function contractTone(status) {
  if (status === 'pass' || status === 'absent' || status === 'forbidden_absent') return 'pass';
  if (status === 'not_observed' || status === 'evidence_gap') return 'low';
  return 'fail';
}

function scoreLabel(key) {
  return {
    visual: 'Visual',
    copy: 'Copy',
    scenario: 'Scenario',
    event: 'Event',
    ending: 'Ending',
    ux: 'UX',
    continuity: 'Continuity',
    commercial_polish: 'Polish',
    dialogue_flow: 'Dialogue',
    choice_consequence: 'Choice',
    emotional_continuity: 'Emotion',
    ending_payoff: 'Ending Payoff',
    world_consistency: 'World',
    player_comprehension: 'Comprehension',
    copy_polish: 'Copy Polish',
  }[key] ?? key;
}

function countSeverity(rows) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const row of rows) {
    for (const finding of [
      ...(row.lint?.findings ?? []),
      ...(row.reviewed?.findings ?? []),
    ]) {
      if (counts[finding.severity] !== undefined) counts[finding.severity] += 1;
    }
  }
  return counts;
}

function countContractFindings(screenRows, flowRows) {
  let fail = 0;
  let notObserved = 0;
  for (const row of [...screenRows, ...flowRows]) {
    fail += row.contract?.failures?.length ?? 0;
    notObserved += row.contract?.notObserved?.length ?? 0;
  }
  return { fail, notObserved };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function readJsonOrDefault(path, fallback) {
  try {
    return await readJson(path);
  } catch {
    return fallback;
  }
}
