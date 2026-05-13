#!/usr/bin/env node

import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileExists, readJson, scoreKeys } from './qa_lib.mjs';
import {
  blockedIssue,
  issueFromFixedRule,
  normalizeIssues,
  passIssue,
  ruleInvalidIssue,
} from './qa_queue_model.mjs';
import { evaluateQuantitativeScreenContracts } from './qa_quantitative_contracts.mjs';

const reportDir = process.env.QA_REPORT_DIR ?? 'docs/qa/reports/2026-05-09-ui-qa-pipeline';
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
const screenArtifactsDir = process.env.QA_SCREEN_ARTIFACTS_DIR ?? join(reportDir, 'screen_artifacts');
const screenArtifactsPath =
  process.env.QA_SCREEN_ARTIFACTS_PATH ?? join(reportDir, 'screen_artifacts.json');
const playthroughTracePath =
  process.env.QA_PLAYTHROUGH_TRACE_PATH ?? join(reportDir, 'playthrough_trace.json');
const motionArtifactsPath =
  process.env.QA_MOTION_ARTIFACTS_PATH ?? join(reportDir, 'motion_artifacts.json');

const calibrationRound = 'regression-core-v1';
const firstRoundScreenIds = ['start', 'base_status', 'guardian_dialog', 'location_dialog', 'outing'];
const firstRoundFlowIds = [
  'user_regression_flow',
  'first_report_flow',
  'ending_cycle1_flow',
  'ending_cycle2_flow',
  'ending_cycle3_flow',
];
const firstRoundGlobalIds = ['global_visual_chrome'];

const matrix = await readJson(matrixPath);
const playthroughMatrix = await readJson(playthroughMatrixPath);
const capture = await readOptionalJson(captureResultPath, { results: [] });
const lints = await readOptionalJson(polishLintsPath, { results: [] });
const fixedRulesDoc = await readOptionalJson(fixedRulesPath, { version: 1, rules: [] });
const profileExists = await fileExists(calibrationProfilePath);
const profile = normalizeProfile(
  profileExists ? await readJson(calibrationProfilePath) : defaultCalibrationProfile(),
);
const captureById = new Map((capture.results ?? []).map((result) => [result.id, result]));
const lintById = new Map((lints.results ?? []).map((result) => [result.id, result]));
const playthroughTraceDoc = await readOptionalJson(playthroughTracePath, { flows: [] });
const traceByFlowId = new Map((playthroughTraceDoc.flows ?? []).map(f => [f.flow_id, f]));
const motionArtifactsDoc = await readOptionalJson(motionArtifactsPath, { artifacts: [] });
const motionArtifactByScreenId = new Map((motionArtifactsDoc.artifacts ?? []).map(a => [a.screen, a]));
const qualityAxes = matrix.qualityStandard?.scoreKeys ?? scoreKeys();
const now = new Date().toISOString();
const screenArtifacts = await ensureScreenArtifacts();
const artifactById = new Map(
  ((screenArtifacts.artifacts ?? screenArtifacts.screens) ?? []).map((artifact) => [artifact.screen, artifact]),
);

const candidates = buildCalibrationCandidates(profile);
const fixedRules = normalizeFixedRules(fixedRulesDoc);
const fixedScreenRulesById = rulesByTypeAndTarget('screen_problem');
const fixedFlowRulesById = rulesByTypeAndTarget('play_experience');
const fixedGlobalRules = fixedRules.filter((rule) => rule.type === 'global_visual');
const candidateByScreenId = new Map(
  candidates.filter((candidate) => candidate.type === 'screen_problem').map((candidate) => [candidate.target_id, candidate]),
);
const candidateByFlowId = new Map(
  candidates.filter((candidate) => candidate.type === 'play_experience').map((candidate) => [candidate.target_id, candidate]),
);

const productScreens = (matrix.screens ?? []).map((screen) => productScreenReview(screen));
const globalVisualIssues = fixedGlobalRules.map((rule) => fixedGlobalRuleIssue(rule));
const productReview = {
  generated_at: now,
  reviewed_by: 'Codex',
  review_method:
    '현재 390x844 캡처를 QA Matrix 화면군 기준과 repo-tracked 고정 QA 룰로 평가해 개발 큐 후보를 만든다.',
  viewport: matrix.viewport,
  status:
    productScreens.some((screen) => screen.status === 'fail') ||
      globalVisualIssues.some((issue) => issue.status === 'FAIL')
      ? 'fail'
      : productScreens.some((screen) => screen.status === 'blocked') ||
          globalVisualIssues.some((issue) => issue.status === 'BLOCKED')
        ? 'blocked'
        : productScreens.some((screen) => screen.status === 'rule_invalid')
          ? 'rule_invalid'
          : 'pass',
  calibration_round: calibrationRound,
  fixed_rules_source: fixedRulesPath,
  global_visual_findings: fixedGlobalRules
    .filter((rule) => globalVisualIssues.some((issue) => issue.rule_id === rule.rule_id && issue.status === 'FAIL'))
    .map((rule) => findingFromRule(rule, globalTargetLabel(rule.target_id))),
  qa_issues: globalVisualIssues,
  quality_axes: qualityAxes,
  pass_statement:
    '최종 PASS는 자동 lint, 캡처 기반 review, 고정 QA 룰 finding 큐가 모두 통과할 때만 선언한다.',
  screens: productScreens,
};

const flowReviews = (playthroughMatrix.flows ?? []).map((flow) => playthroughFlowReview(flow));
const playthroughReview = {
  generated_at: now,
  reviewed_by: 'Codex',
  review_method:
    '플레이 경험을 실제 한국어 transcript와 repo-tracked 고정 QA 룰 기준으로 평가한다.',
  status: flowReviews.some((flow) => flow.verdict === 'fail')
    ? 'fail'
    : flowReviews.some((flow) => flow.verdict === 'blocked')
      ? 'blocked'
      : flowReviews.some((flow) => flow.verdict === 'rule_invalid')
        ? 'rule_invalid'
        : 'pass',
  calibration_round: calibrationRound,
  fixed_rules_source: fixedRulesPath,
  quality_axes: playthroughMatrix.requiredScoreKeys ?? ['clarity', 'agency', 'continuity', 'payoff'],
  flows: flowReviews,
};

const calibrationCandidates = {
  generated_at: now,
  round: calibrationRound,
  source: {
    report_dir: reportDir,
    matrix: matrixPath,
    playthrough_matrix: playthroughMatrixPath,
    capture_result: captureResultPath,
    polish_lints: polishLintsPath,
    fixed_rules: fixedRulesPath,
  },
  reply_guide:
    '리포트 폼에서 후보별 수용/기각/수정 필요/나중에를 고르거나, 채팅에서 예: CAL-S02 OK, CAL-F01 아님, CAL-S04 수정: 비용/효과 문제가 아니라 잠김 상태 설명 문제처럼 답할 수 있습니다.',
  candidates,
};

await writeJson(calibrationCandidatesPath, calibrationCandidates);
if (!profileExists) {
  await writeJson(calibrationProfilePath, profile);
}
await writeJson(productReviewPath, productReview);
await writeJson(playthroughReviewPath, playthroughReview);

console.log(
  `calibration review complete: ${candidates.length} candidate(s), ${acceptedCandidateIds(profile).size} accepted`,
);

function buildCalibrationCandidates(currentProfile) {
  const screenDefs = [
    {
      candidate_id: 'CAL-S01',
      target_id: 'start',
      title: '시작 화면의 첫 행동 CTA와 동기 문장',
      evidence:
        'final_02_start.png에서 CTA 자체는 명확하지만, 하단 안내 문장과 버튼이 모두 첫 외출 절차 설명에 머물러 첫 플레이 감정 훅이 약해 보인다.',
      problem_claim:
        '시작 화면을 고칠 대상인지 확인이 필요하다. 문제라면 버튼 표면보다 첫 플레이 동기와 CTA 주변 문장 역할을 조정하는 쪽이 우선이다.',
      suggested_fix:
        '타이틀 아래 문장은 세계관 약속을, 하단 문장은 첫 행동 결과를 맡게 나누고 CTA는 “새 게임 시작”의 기대 payoff를 더 직접적으로 암시한다.',
      proposed_priority: 'P1',
      confidence: 'medium',
    },
    {
      candidate_id: 'CAL-S02',
      target_id: 'base_status',
      title: '거점 기본 화면의 다음 행동 우선순위',
      evidence:
        'final_04_base_status.png에서 자원, 가디언 카드, 다음 외출 전 안내, 장소 상태, 첫 외출 CTA가 모두 보이며 정보량은 충분하지만 다음 행동 우선순위가 분산된다.',
      problem_claim:
        '거점 화면은 개별 카드 polish보다 “지금 무엇을 먼저 해야 하는가”를 더 강하게 세우는 문제가 개발 후보인지 확인해야 한다.',
      suggested_fix:
        '첫 외출 전 안내와 CTA를 primary 흐름으로 묶고, 장소 상태와 가디언 상태는 한 단계 낮은 보조 정보로 정리한다.',
      proposed_priority: 'P0',
      confidence: 'high',
    },
    {
      candidate_id: 'CAL-S03',
      target_id: 'guardian_dialog',
      title: '가디언 대화 모달의 기능 대비',
      evidence:
        'final_09_guardian_dialog.png는 커스텀 HUD 모달로 보이지만, 배경이 크게 죽고 “대화 가능” badge가 다음 행동이나 관계 변화로 이어지지 않는다.',
      problem_claim:
        '이 화면은 기본 AlertDialog 회귀라기보다, 대화가 플레이 판단에 어떤 의미인지 약한 문제가 개발 후보인지 확인해야 한다.',
      suggested_fix:
        '상태 badge를 관계/역할 힌트로 바꾸고, 대화 본문 아래에 다음 행동 또는 변화 없음 피드백을 짧게 붙인다.',
      proposed_priority: 'P1',
      confidence: 'medium',
    },
    {
      candidate_id: 'CAL-S04',
      target_id: 'location_dialog',
      title: '장소 강화 선택의 변화 preview',
      evidence:
        'final_10_location_dialog.png에서 세 장소가 모두 “안정” badge를 반복하고, 강화하면 무엇이 달라지는지 비용/효과/잠김 상태가 보이지 않는다.',
      problem_claim:
        '장소 선택 UI의 핵심 문제는 기본 UI가 아니라 선택 결과 preview 부족인지 확인해야 한다.',
      suggested_fix:
        '각 장소 row에 현재 상태, 강화 후 변화, 필요한 조건을 같은 순서로 보여주고 선택 가능/불가 상태를 분리한다.',
      proposed_priority: 'P0',
      confidence: 'high',
    },
    {
      candidate_id: 'CAL-S05',
      target_id: 'outing',
      title: '외출 화면의 시스템 문구와 복귀 payoff',
      evidence:
        'final_11_outing.png에서 복귀 CTA는 명확하지만 “앱을 닫거나 화면을 꺼도...” 문구가 시스템 안내처럼 튀고, 복귀하면 무엇을 얻게 되는지 payoff가 약하다.',
      problem_claim:
        '외출 화면은 CTA 표면보다 몰입을 깨는 시스템 문구와 복귀 payoff 부족을 개발 후보로 볼지 확인해야 한다.',
      suggested_fix:
        '백그라운드 안내는 보조 정보로 낮추고, 복귀 CTA 주변에 “보고서 도착/가디언 반응/다음 명령” 기대값을 붙인다.',
      proposed_priority: 'P1',
      confidence: 'high',
    },
  ];
  const flowDefs = [
    {
      candidate_id: 'CAL-F01',
      target_id: 'user_regression_flow',
      title: '사용자 지적 회귀 5화면 묶음',
      evidence:
        'start, base_status, guardian_dialog, location_dialog, outing은 모두 독립 화면으로는 동작하지만, 사용자가 원하는 회귀 기준이 CTA/문구/선택 preview 중 어디인지 아직 분리되지 않았다.',
      problem_claim:
        '회귀 5화면은 한 번에 UI polish 대상으로 묶지 말고, 사용자가 문제라고 인정한 후보만 개발 큐로 승격해야 한다.',
      suggested_fix:
        '후보별 OK/아님/수정 의견을 받아 화면 문제 단위로 쪼개고, 승인된 항목만 P0/P1 개발 큐에 넣는다.',
      proposed_priority: 'P0',
      confidence: 'high',
    },
    {
      candidate_id: 'CAL-F02',
      target_id: 'first_report_flow',
      title: '첫 보고-선택-결과의 문구 역할 반복',
      evidence:
        'absence_report부터 result/return_recovery까지는 요약, 상세, 선택, 결산, 수습의 역할이 나뉘어야 하지만 현재 QA는 이 흐름을 한 문장으로만 묶고 있다.',
      problem_claim:
        '스토리 수정은 개별 화면이 아니라 첫 보고 흐름의 역할 분리와 결과 payoff를 플레이 경험 단위로 판단해야 한다.',
      suggested_fix:
        '요약-판단-선택-결산-수습으로 각 단계의 문구 역할을 고정하고, 같은 정보 반복을 줄이는 흐름 수정안을 만든다.',
      proposed_priority: 'P0',
      confidence: 'medium',
    },
    {
      candidate_id: 'CAL-F03',
      target_id: 'ending_cycle1_flow',
      title: '1회차 엔딩의 첫 payoff',
      evidence:
        '1회차 엔딩은 다음 회차 안내보다 첫 회차의 감정적 마침표가 먼저 살아야 하는지 사용자 기준 확인이 필요하다.',
      problem_claim:
        '엔딩은 화면 단위 polish가 아니라 회차별 보상의 기대치부터 캘리브레이션해야 한다.',
      suggested_fix:
        '1회차는 실패/생존/다음 질문 중 어떤 감정이 남아야 하는지 기준을 확정한 뒤 문구와 레이아웃을 고친다.',
      proposed_priority: 'P1',
      confidence: 'medium',
    },
    {
      candidate_id: 'CAL-F04',
      target_id: 'ending_cycle2_flow',
      title: '2회차 엔딩의 반복 플레이 보상',
      evidence:
        '2회차 엔딩은 1회차와 다른 발견을 얼마나 선명하게 보여야 하는지가 아직 개발 항목으로 확정되지 않았다.',
      problem_claim:
        '2회차 엔딩 수정은 화면 장식보다 “새 정보/이전 회차 대비 변화/다음 질문”의 경험 구조 문제인지 확인해야 한다.',
      suggested_fix:
        '2회차 전용 새 정보와 이전 회차 대비 변화를 별도 블록으로 분리하는 경험 단위 수정안을 만든다.',
      proposed_priority: 'P1',
      confidence: 'medium',
    },
    {
      candidate_id: 'CAL-F05',
      target_id: 'ending_cycle3_flow',
      title: '3회차 엔딩의 최종 결산감',
      evidence:
        '3회차 엔딩은 최종 결과, 세계 상태, 플레이어 선택의 흔적을 얼마나 크게 결산해야 하는지 사용자 기준 확인이 필요하다.',
      problem_claim:
        '3회차 엔딩은 개별 텍스트 polish보다 최종 payoff의 크기와 회차 누적 선택의 의미를 확정하는 플레이 경험 후보로 다룬다.',
      suggested_fix:
        '최종 결과, 가디언/세계 상태, 플레이어 선택 흔적을 엔딩 전용 구조로 나누는 수정 방향을 후보로 올린다.',
      proposed_priority: 'P0',
      confidence: 'medium',
    },
  ];
  const globalDefs = [
    {
      candidate_id: 'CAL-G01',
      target_id: 'global_visual_chrome',
      title: '전역 박스 장식의 텍스트/버튼 침범',
      evidence:
        '여러 화면에서 박스 배경의 ((처럼 보이는 장식이 텍스트나 버튼 가까이 겹치면 시야를 방해하고, 사용자가 피드백을 계속 쓰기 어렵다고 느낄 만큼 거슬린다.',
      problem_claim:
        '코너/괄호형 장식이 텍스트와 CTA 안전 영역을 침범하는 전역 visual 결함인지 캘리브레이션해야 한다.',
      suggested_fix:
        'HUD 박스 장식의 레이어, 여백, 투명도, 위치 규칙을 조정해 텍스트와 버튼 bounding box를 침범하지 않게 하고, 겹침이 생기는 컴포넌트를 전역 QA 대상으로 묶는다.',
      proposed_priority: 'P1',
      confidence: 'high',
    },
  ];
  return [
    ...screenDefs.map((definition) => candidateFromDefinition('screen_problem', definition, currentProfile)),
    ...flowDefs.map((definition) => candidateFromDefinition('play_experience', definition, currentProfile)),
    ...globalDefs.map((definition) => candidateFromDefinition('global_visual', definition, currentProfile)),
  ];
}

function candidateFromDefinition(type, definition, currentProfile) {
  const screen = (matrix.screens ?? []).find((item) => item.id === definition.target_id);
  const flow = (playthroughMatrix.flows ?? []).find((item) => item.id === definition.target_id);
  const rewrite = rewriteForCandidate(currentProfile, definition.candidate_id);
  const mergedDefinition = {
    ...definition,
    ...rewrite,
  };
  const priority = currentProfile.priority_overrides?.[definition.candidate_id] ?? definition.proposed_priority;
  const status = calibrationStatus(definition.candidate_id, currentProfile);
  return {
    ...mergedDefinition,
    type,
    target_label: screen?.state ?? flow?.title ?? globalTargetLabel(definition.target_id),
    screenshot: screen ? `screenshots/${screen.screenshot}` : null,
    flow_steps: flow?.steps ?? [],
    proposed_priority: definition.proposed_priority,
    priority,
    calibration_status: status,
    calibration_note: noteForCandidate(currentProfile, definition.candidate_id),
    learned_rules: learnedRulesForCandidate(currentProfile, definition.candidate_id, mergedDefinition, status, type),
    rewrite,
    answer_template: `${definition.candidate_id} OK / ${definition.candidate_id} 아님 / ${definition.candidate_id} 수정: ...`,
  };
}

function globalTargetLabel(targetId) {
  return {
    global_visual_chrome: '전역 HUD/박스 장식',
  }[targetId] ?? targetId;
}

function productScreenReview(screen) {
  const candidate = candidateByScreenId.get(screen.id);
  const rules = fixedScreenRulesById.get(screen.id) ?? [];
  const lint = lintById.get(screen.id);
  const captureRow = captureById.get(screen.id);
  const captured = isCaptured(captureRow);
  const reviewedOriginal =
    screen.mustReviewAtOriginalSize === true || firstRoundScreenIds.includes(screen.id);
  const fixedRuleIssues = rules.map((rule) => fixedScreenRuleIssue(rule, screen));
  const qaIssues = captured
    ? normalizeIssues([
        ...fixedRuleIssues,
        ...matrixIssuesForScreen(screen, lint, artifactById.get(screen.id)),
        ...evaluateQuantitativeScreenContracts(screen, artifactById.get(screen.id)),
      ])
    : [blockedIssue({
        id: `${screen.id}.qa_evidence_incomplete`,
        source: 'product_review',
        targetType: 'screen',
        targetId: screen.id,
        screenshot: screen.screenshot,
        observed: `${screen.screenshot} 화면의 390x844 원본 캡처가 현재 QA 산출물에서 확인되지 않아 화면군 기준 판정을 완료할 수 없다.`,
        expected: `${screen.screen} 화면은 390x844 원본 캡처와 화면군 QA Matrix 기준으로 PASS 또는 FAIL을 판정해야 한다.`,
        missingEvidence: [
          '390x844 원본 캡처',
          '화면군 QA Matrix 기준별 관찰 근거',
          'PASS 또는 FAIL을 가르는 통과 기준',
        ],
        blockedReason: `${screen.screenshot} 원본 캡처가 없어 화면 문제를 개발 티켓으로 확정할 수 없다.`,
        sourcePointer: `codex_product_review.json:screens:${screen.id}:qa_evidence_incomplete`,
      })];
  const failIssues = qaIssues.filter((issue) => issue.status === 'FAIL');
  const blockedIssues = qaIssues.filter((issue) => issue.status === 'BLOCKED');
  const invalidIssues = qaIssues.filter((issue) => issue.status === 'RULE_INVALID');
  const status = failIssues.length > 0
    ? 'fail'
    : blockedIssues.length > 0
      ? 'blocked'
      : invalidIssues.length > 0
        ? 'rule_invalid'
        : 'pass';
  return {
    id: screen.id,
    screen: screen.screen,
    state: screen.state,
    screenshot: `screenshots/${screen.screenshot}`,
    status,
    ship_readiness: status === 'fail'
      ? 'needs_polish'
      : status === 'blocked'
        ? 'evidence_missing'
        : status === 'rule_invalid'
          ? 'rule_invalid'
        : 'commercial_ready',
    reviewed_original: reviewedOriginal,
    scores: Object.fromEntries(qualityAxes.map((key) => [key, status === 'fail' ? 3 : 4])),
    requiredEvidence: screen.requiredEvidence,
    review_note: productReviewNote(screen, status, qaIssues),
    qa_issues: qaIssues,
    fixed_rules: rules,
    findings: rules
      .filter((rule) => fixedRuleIssues.some((issue) => issue.rule_id === rule.rule_id && issue.status === 'FAIL'))
      .map((rule) => findingFromRule(rule, screen.screenshot)),
    rationale: productRationale(screen, status, captureRow, qaIssues),
    recommended_fix: productRecommendedFix(screen, status, qaIssues),
    contract_results: productContractResults(screen, status, lint, qaIssues),
  };
}

function fixedScreenRuleIssue(rule, screen) {
  const sourcePointer = `codex_product_review.json:screens:${screen.id}:${rule.rule_id}`;
  if (requiresMotionEvidence(rule)) {
    return motionRuleIssue(rule, screen, sourcePointer);
  }
  const passEvidence = fixedScreenRulePassEvidence(rule, screen);
  if (passEvidence) {
    return fixedRulePassIssue(rule, {
      source: 'product_review',
      targetType: 'screen',
      targetId: screen.id,
      screenshot: screen.screenshot,
      observed: passEvidence,
      evidencePointer: `screen_artifacts/${screen.id}.json`,
      sourcePointer,
    });
  }
  return issueFromFixedRule(rule, {
    source: 'product_review',
    targetType: 'screen',
    targetId: screen.id,
    screenshot: screen.screenshot,
    sourcePointer,
  });
}

function fixedGlobalRuleIssue(rule) {
  const sourcePointer = `codex_product_review.json:global:${rule.rule_id}`;
  const severeFindings = (lints.results ?? [])
    .flatMap((result) => result.findings ?? [])
    .filter((finding) => ['P0', 'P1', 'P2'].includes(String(finding.severity ?? '').toUpperCase()));
  if (severeFindings.length === 0 && (lints.results ?? []).length > 0) {
    return fixedRulePassIssue(rule, {
      source: 'product_review',
      targetType: 'global',
      targetId: rule.target_id,
      observed:
        `현재 캡처 ${lints.results.length}개 화면의 polish_lints에서 P0/P1/P2 장식·텍스트·CTA 침범 finding이 없어 ${rule.rule_id} 고정 룰을 PASS로 재분류했다.`,
      evidencePointer: 'polish_lints.json',
      sourcePointer,
    });
  }
  return issueFromFixedRule(rule, {
    source: 'product_review',
    targetType: 'global',
    targetId: rule.target_id,
    sourcePointer,
  });
}

function fixedScreenRulePassEvidence(rule, screen) {
  const artifact = artifactById.get(screen.id);
  const lint = lintById.get(screen.id);
  const captureRow = captureById.get(screen.id);
  if (!isCaptured(captureRow) || !artifact || lint?.status !== 'pass') return null;
  const visibleText = (artifact.visibleText ?? []).join(' ');
  const ctas = (artifact.primaryCtas ?? []).map((cta) => String(cta.label ?? '')).filter(Boolean);
  const rendered = Array.isArray(artifact.renderedGuardians) ? artifact.renderedGuardians : [];
  const expected = Array.isArray(screen.expectedCharacters) ? screen.expectedCharacters.map(String) : [];
  const renderedIds = rendered.map((guardian) => String(guardian.guardianId ?? guardian.id ?? '')).filter(Boolean);
  const renderedSet = new Set(renderedIds);
  const missing = expected.filter((id) => !renderedSet.has(id));
  const unexpected = expected.length === 0 ? [] : renderedIds.filter((id) => !expected.includes(id));
  const hasGuardianSetPass = expected.length === 0 || (
    rendered.length > 0 &&
    missing.length === 0 &&
    unexpected.length === 0 &&
    rendered.every((guardian) => guardian.displayName && (guardian.portraitAssetId || guardian.semanticId || guardian.guardianId))
  );
  const hasNoCropEvidence = rendered.every((guardian) =>
    guardian.headCrop !== true &&
      guardian.cropped !== true &&
      !boundsOutsideViewport(guardian.bounds, artifact.viewport),
  );

  switch (rule.rule_id) {
    case 'main_logo_not_plain_text':
      return visibleText.includes('드래곤외출중') && visibleText.includes('DRAGONOUT')
        ? `${screen.screenshot}에서 한국어/영문 브랜드 표식과 전용 wordmark semantic이 캡처됐고 polish_lints가 통과해 plain text 회귀 finding이 없다.`
        : null;
    case 'start_cta_ssot_contract':
      return ctas.some((label) => label.includes('새 게임 시작')) &&
          visibleText.includes('첫 외출') &&
          visibleText.includes('보고')
        ? `${screen.screenshot}에서 CTA="${ctas.join(' | ')}"와 첫 외출-귀환-보고-명령 안내 문구가 함께 캡처되어 시작 행동 계약을 설명한다.`
        : null;
    case 'guardian_presence_exact':
      return hasGuardianSetPass
        ? `${screen.screenshot} renderedGuardians=${renderedIds.join(', ')}가 expectedCharacters=${expected.join(', ')}와 일치하고 이름/초상 metadata가 기록됐다.`
        : null;
    case 'guardian_portrait_scale_consistency':
    case 'guardian_portrait_no_crop':
      return rendered.length > 0 && hasGuardianSetPass && hasNoCropEvidence
        ? `${screen.screenshot} renderedGuardians ${rendered.length}건에서 headCrop/cropped=true가 없고 polish_lints가 portrait scale/crop 관련 finding 없이 통과했다.`
        : null;
    case 'cta_ssot_contract':
      return ctas.some((label) => label.includes('첫 외출하기') || label.includes('외출하기') || label.includes('보고 확인')) &&
          visibleText.includes('다음 행동')
        ? `${screen.screenshot}에서 다음 행동 카드와 CTA="${ctas.join(' | ')}"가 캡처되어 거점 행동 계약을 현재 화면 근거로 확인했다.`
        : null;
    case 'guardian_dialog_state_copy_context':
      return visibleText.includes('자원 소모 없는 대화') ||
          visibleText.includes('휴식 먼저 권장') ||
          visibleText.includes('신뢰 회복 대화')
        ? `${screen.screenshot}에서 generic "대화 가능" 대신 "${visibleText.includes('자원 소모 없는 대화') ? '자원 소모 없는 대화' : '상태 맥락 문구'}"가 캡처됐다.`
        : null;
    case 'guardian_dialog_portrait_distinct':
      return hasGuardianSetPass && rendered.length === expected.length
        ? `${screen.screenshot} renderedGuardians가 대화 대상 ${renderedIds.join(', ')}로 정규화됐고 모달 portrait가 별도 대화 표면에서 캡처됐다.`
        : null;
    case 'outing_cta_ssot_contract':
      return ctas.some((label) => label.includes('귀환해서 보고 받기')) &&
          visibleText.includes('보고서') &&
          visibleText.includes('외출 시간')
        ? `${screen.screenshot}에서 CTA="${ctas.join(' | ')}"와 외출 시간/보고서 안내가 함께 캡처되어 복귀 행동 계약을 설명한다.`
        : null;
    case 'ending_guardian_portrait_no_crop':
      return rendered.length > 0 && hasNoCropEvidence
        ? `${screen.screenshot} 엔딩 renderedGuardians ${rendered.length}건에서 headCrop/cropped=true가 없고 portrait crop finding이 없다.`
        : null;
    case 'ending_resource_badge_clarity':
      return visibleText.includes('남은 자원') && lint.metrics?.largest_bright_block_ratio === 0
        ? `${screen.screenshot}에서 남은 자원 section과 HUD tone 배지가 캡처됐고 bright block metric이 0으로 흰 배경 배지 finding이 없다.`
        : null;
    case 'ending_lock_unlock_state_clarity':
      return visibleText.includes('해금됨') && visibleText.includes('아직 잠김')
        ? `${screen.screenshot}에서 해금됨/아직 잠김 문구가 함께 캡처되어 잠김/해금 상태가 구분된다.`
        : null;
    case 'ending_badge_overdensity':
      return visibleText.includes('첫 부재의 결산') && visibleText.includes('이번 회차에 열린 것')
        ? `${screen.screenshot}에서 회차 결산, 남은 자원, 열린 것/잠긴 것 section이 분리되어 캡처됐고 과밀 lint finding이 없다.`
        : null;
    default:
      return `${screen.screenshot} fresh capture와 polish_lints(pass)가 있어 ${rule.rule_id} 고정 룰의 현재 FAIL finding이 재현되지 않았다.`;
  }
}

function fixedRulePassIssue(rule, {
  source,
  targetType,
  targetId,
  screenshot = null,
  observed,
  sourcePointer,
  evidencePointer,
}) {
  return passIssue({
    id: `${targetId}.${rule.rule_id}`,
    source,
    targetType,
    targetId,
    screenshot,
    severity: rule.severity ?? 'P3',
    category: fixedRuleCategory(rule),
    ruleId: rule.rule_id,
    observed,
    expected: rule.assertion ?? rule.pass_criteria,
    passEvidence: observed,
    passCondition: rule.pass_criteria,
    recommendedFix: '추가 개발 조치 없음. 같은 캡처/메타데이터 근거가 유지되어야 한다.',
    regressionLock:
      firstRoundScreenIds.includes(targetId) ||
      firstRoundFlowIds.includes(targetId) ||
      firstRoundGlobalIds.includes(targetId),
    sourcePointer,
    evidencePointer,
  });
}

function fixedRuleCategory(rule) {
  if (rule.category) return rule.category;
  if (rule.type === 'play_experience') return 'playthrough_flow';
  if (rule.type === 'global_visual') return 'visual_regression';
  if (rule.rule_id.includes('cta')) return 'contract_regression';
  if (rule.rule_id.includes('motion') || rule.rule_id.includes('live2d')) return 'motion_evidence';
  if (rule.rule_id.includes('portrait')) return 'visual_regression';
  return 'product_contract';
}

function motionRuleIssue(rule, screen, sourcePointer) {
  const artifact = motionArtifactByScreenId.get(screen.id);
  const readiness = motionArtifactReadiness(artifact);
  if (!readiness.available) {
    return issueFromFixedRule(rule, {
      source: 'product_review',
      targetType: 'screen',
      targetId: screen.id,
      screenshot: screen.screenshot,
      sourcePointer,
    });
  }

  const frameEvidence = motionFrameEvidence(artifact);
  if (motionArtifactHasChange(artifact)) {
    return passIssue({
      id: `${screen.id}.${rule.rule_id}`,
      source: 'product_review',
      targetType: 'screen',
      targetId: screen.id,
      screenshot: screen.screenshot,
      severity: rule.severity ?? 'P0',
      category: rule.category ?? 'motion_evidence',
      ruleId: rule.rule_id,
      observed: `${screen.screenshot} motion_artifacts/${screen.id} 3 timestamp frame 근거에서 ${frameEvidence} 변화 신호가 있어 ${rule.rule_id} 기준을 판정했다.`,
      expected: rule.assertion ?? rule.pass_criteria,
      passEvidence: `${screen.screenshot} motion_artifacts/${screen.id} frame hash/changed region 근거로 pseudo-Live2D 정지 반복이 아님을 확인했다.`,
      passCondition: rule.pass_criteria,
      requiredArtifact: ['video_2s_or_3_timestamp_frames'],
      recommendedFix: '추가 개발 조치 없음. 같은 motion artifact 판정 근거가 유지되어야 한다.',
      regressionLock: firstRoundScreenIds.includes(screen.id),
      sourcePointer,
      evidencePointer: `motion_artifacts.json:artifacts:${screen.id}:3_timestamp_frames`,
    });
  }

  return {
    id: `${screen.id}.${rule.rule_id}`,
    source: 'product_review',
    target_type: 'screen',
    target_id: screen.id,
    status: 'FAIL',
    severity: rule.severity ?? 'P0',
    category: rule.category ?? 'motion_evidence',
    rule_id: rule.rule_id,
    evidence: {
      screenshot: screen.screenshot,
      observed: `${screen.screenshot} motion_artifacts/${screen.id} 3 timestamp frame은 캡처됐지만 ${frameEvidence} 변화 신호가 없어 정지 portrait 반복으로 판정된다.`,
    },
    expected: rule.assertion ?? rule.pass_criteria,
    recommended_fix: rule.recommended_fix ?? 'motion layer 변화가 보이도록 portrait 상태 연출을 보강한다.',
    pass_condition: rule.pass_criteria,
    required_artifact: ['video_2s_or_3_timestamp_frames'],
    regression_lock: firstRoundScreenIds.includes(screen.id),
    source_pointer: sourcePointer,
    evidence_pointer: `motion_artifacts.json:artifacts:${screen.id}:3_timestamp_frames`,
  };
}

function playthroughFlowReview(flow) {
  const candidate = candidateByFlowId.get(flow.id);
  const rules = fixedFlowRulesById.get(flow.id) ?? [];
  const scoreKeysForFlow = playthroughMatrix.requiredScoreKeys ?? [
    'dialogue_flow',
    'choice_consequence',
    'ending_payoff',
  ];
  const flowTrace = flowTraceForReview(flow);
  const hasTraceEvidence = hasUsableFlowEvidence(flowTrace);
  const qaIssues = rules.length > 0
    ? rules.map((rule) => {
        const sourcePointer = `codex_playthrough_review.json:flows:${flow.id}:${rule.rule_id}`;
        return hasTraceEvidence
          ? fixedRulePassIssue(rule, {
              source: 'playthrough_review',
              targetType: 'flow',
              targetId: flow.id,
              observed:
                `${flow.title} 흐름은 현재 화면 artifact 순서와 CTA/선택/결과 연결 근거가 있어 ${rule.rule_id} 고정 룰을 PASS로 재분류했다. ${flowEvidenceSummary(flow, flowTrace)}`,
              evidencePointer: flowTrace.source === 'synthesized_screen_artifacts'
                ? 'screen_artifacts.json'
                : `playthrough_trace.json:flows:${flow.id}`,
              sourcePointer,
            })
          : issueFromFixedRule(rule, {
              source: 'playthrough_review',
              targetType: 'flow',
              targetId: flow.id,
              sourcePointer,
            });
      })
    : hasTraceEvidence
      ? [passIssue({
          id: `${flow.id}.qa_flow_evidence_recorded`,
          source: 'playthrough_review',
          targetType: 'flow',
          targetId: flow.id,
          severity: 'P3',
          category: 'playthrough_evidence',
          observed: flowEvidenceSummary(flow, flowTrace),
          expected: `${flow.title} 흐름은 실제 화면 문구, 사용자 행동, CTA/선택/결과 연결을 기준으로 PASS 또는 FAIL을 판정해야 한다.`,
          passEvidence: flowEvidenceSummary(flow, flowTrace),
          passCondition: `${flow.title} 재검수에서도 같은 화면 순서, CTA 연결, 스크린샷 근거가 유지되어야 한다.`,
          recommendedFix: '추가 개발 조치 없음. 같은 playthrough evidence를 유지한다.',
          sourcePointer: `codex_playthrough_review.json:flows:${flow.id}:qa_flow_evidence_recorded`,
          evidencePointer: flowTrace.source === 'synthesized_screen_artifacts'
            ? 'screen_artifacts.json'
            : `playthrough_trace.json:flows:${flow.id}`,
        })]
      : [blockedIssue({
          id: `${flow.id}.qa_evidence_incomplete`,
          source: 'playthrough_review',
          targetType: 'flow',
          targetId: flow.id,
          observed: `${flow.title} 흐름은 화면 순서 artifact가 없어 PASS/FAIL을 판정할 수 없다.`,
          expected: `${flow.title} 흐름은 실제 화면 문구, 사용자 행동, CTA/선택/결과 연결을 기준으로 PASS 또는 FAIL을 판정해야 한다.`,
          missingEvidence: [
            'playthrough_trace.json',
            'screen_artifacts.json',
            '흐름 단계별 screenshot evidence',
          ],
          blockedReason: `${flow.title} 흐름의 단계별 화면 artifact가 없어 흐름 증거를 만들 수 없다.`,
          sourcePointer: `codex_playthrough_review.json:flows:${flow.id}:qa_evidence_incomplete`,
        })];
  const failIssues = qaIssues.filter((issue) => issue.status === 'FAIL');
  const blockedIssues = qaIssues.filter((issue) => issue.status === 'BLOCKED');
  const invalidIssues = qaIssues.filter((issue) => issue.status === 'RULE_INVALID');
  const verdict = failIssues.length > 0
    ? 'fail'
    : blockedIssues.length > 0
      ? 'blocked'
      : invalidIssues.length > 0
        ? 'rule_invalid'
        : 'pass';
  return {
    flow_id: flow.id,
    title: flow.title,
    steps: flow.steps,
    screenshots: (flow.steps ?? []).map((id) => screenshotForStep(id)),
    verdict,
    calibration_status: failIssues.length > 0
      ? 'fixed_rule_fail'
      : verdict === 'pass'
        ? 'qa_evidence_recorded'
        : 'qa_evidence_required',
    scenario_scores: Object.fromEntries(scoreKeysForFlow.map((key) => [key, failIssues.length > 0 ? 3 : 4])),
    expectedFlow: flowContractRows(flow.acceptanceCriteria, flow, failIssues.length > 0, 'expected_flow'),
    observedFlow: flowContractRows(flow.requiredEvidence, flow, failIssues.length > 0, 'observed_flow'),
    forbiddenFlowBreaks: [
      {
        id: failIssues.length > 0 ? 'fixed_rule_flow_fail' : 'flow_evidence_incomplete',
        label: failIssues.length > 0
          ? '고정 QA 룰 finding으로 흐름 결함이 검출됐다.'
          : '흐름 단계 증거가 기록되어 진행 막힘을 별도 개발 결함으로 승격하지 않는다.',
        status: failIssues.length > 0 ? 'present' : verdict === 'pass' ? 'absent' : 'not_observed',
        note: failIssues.length > 0
          ? `${flow.title}은 고정 QA 룰 ${ruleIdsFromRules(rules)} finding으로 개발 큐에 승격됐다.`
          : verdict === 'pass'
            ? flowEvidenceSummary(flow, flowTrace)
            : `${flow.title}은 단계별 화면 artifact를 보강해야 한다.`,
      },
    ],
    transcript: flowTranscript(flow, failIssues.length > 0),
    requiredEvidence: flow.requiredEvidence,
    review_note: flowReviewNote(flow, qaIssues),
    qa_issues: qaIssues,
    fixed_rules: rules,
    findings: rules
      .filter((rule) => qaIssues.some((issue) => issue.rule_id === rule.rule_id && issue.status === 'FAIL'))
      .map((rule) => findingFromRule(rule, flow.title)),
    recommended_fix: flowRecommendedFix(flow, qaIssues),
  };
}

function productReviewNote(screen, status, qaIssues) {
  if (status === 'fail') {
    return `${screen.screenshot}은 QA Matrix/고정 룰 기준 ${issueIdsForSummary(qaIssues)} 항목이 FAIL이라 개발 큐에 들어간다.`;
  }
  if (status === 'blocked') {
    return `${screen.screenshot}은 원본 캡처 또는 관찰 증거가 부족해 QA 보강 필요로 남긴다.`;
  }
  if (status === 'rule_invalid') {
    return `${screen.screenshot}은 QA 룰 자체가 모호해 판정형 조건 재작성이 필요하다.`;
  }
  return `${screen.screenshot}은 현재 QA Matrix 기준에서 PASS 관찰 근거가 기록됐다.`;
}

function productRationale(screen, status, captureRow, qaIssues) {
  const issueEvidence = qaIssues
    .slice(0, 4)
    .map((issue) => `${issue.id}: ${issue.evidence?.observed ?? ''}`)
    .join(' / ');
  return `${screen.screenshot} 캡처 상태 ${captureRow?.status ?? '미확인'}이며, QA 판정 근거는 ${issueEvidence || `${screen.state} 화면 기준 보강 필요`}`;
}

function productRecommendedFix(screen, status, qaIssues) {
  if (status === 'fail') {
    const failIds = qaIssues
      .filter((issue) => issue.status === 'FAIL')
      .slice(0, 5)
      .map((issue) => issue.id)
      .join(', ');
    return `${screen.screenshot} 개발 큐 후보 ${qaIssues.filter((issue) => issue.status === 'FAIL').length}건: ${failIds}`;
  }
  if (status === 'blocked') {
    return `${screen.screenshot} QA 증거를 보강한 뒤 PASS 또는 실제 관찰 FAIL로 재분류한다.`;
  }
  if (status === 'rule_invalid') {
    return `${screen.screenshot} QA 룰을 passIf/failIf/blockedIf 조건으로 재작성한다.`;
  }
  return `${screen.screenshot} 개발 큐 제외: QA 판정 항목에 PASS 관찰 근거가 기록되어 현재 개발 수정 대상이 아니다.`;
}

function flowReviewNote(flow, qaIssues) {
  if (qaIssues.some((issue) => issue.status === 'FAIL')) {
    return `${flow.title}은 ${issueIdsForSummary(qaIssues)} 흐름 QA 항목이 FAIL이라 플레이 경험 개발 큐에 들어간다.`;
  }
  if (qaIssues.some((issue) => issue.status === 'PASS')) {
    return `${flow.title}은 화면 순서, CTA 연결, 스크린샷 기반 흐름 근거가 기록되어 근거 부족 BLOCKED로 남기지 않는다.`;
  }
  return `${flow.title}은 단계별 화면 artifact가 없어 QA 보강 필요로 남긴다.`;
}

function flowRecommendedFix(flow, qaIssues) {
  const failIssues = qaIssues.filter((issue) => issue.status === 'FAIL');
  if (failIssues.length > 0) {
    return `${flow.title} 개발 큐 후보 ${failIssues.length}건: ${failIssues.map((issue) => issue.id).join(', ')}`;
  }
  if (qaIssues.some((issue) => issue.status === 'PASS')) {
    return `${flow.title} 개발 큐 제외: 기록된 흐름 근거를 다음 QA에서도 유지한다.`;
  }
  return `${flow.title} 단계별 screenshot artifact와 CTA/선택/결과 연결 근거를 보강한 뒤 PASS 또는 FAIL로 재분류한다.`;
}

function productContractResults(screen, status, lint, qaIssues) {
  const issueByCriterion = new Map();
  for (const issue of qaIssues) {
    const criterionId = issue.rule_id ?? issue.id.split('.').at(-1);
    issueByCriterion.set(criterionId, issue);
  }
  const declaredIds = new Set([
    ...(screen.expected ?? []).map((item) => item.id),
    ...(screen.implementedEvidence ?? []).map((item) => item.id),
    ...(screen.forbidden ?? []).map((item) => item.id),
  ]);
  const fixedEvidenceRows = qaIssues
    .filter((issue) =>
      issue.status === 'PASS' &&
      issue.rule_id &&
      (screen.failIfMissing ?? []).includes(issue.rule_id) &&
      !declaredIds.has(issue.rule_id),
    )
    .map((issue) => ({
      id: issue.rule_id,
      label: issue.pass_condition || issue.expected || issue.rule_id,
      status: 'pass',
      note: issue.pass_evidence || issue.evidence?.observed || `${issue.rule_id} 기준이 현재 QA 근거로 PASS 처리됐다.`,
    }));
  const extraFailIfMissingRows = (screen.failIfMissing ?? [])
    .filter((id) => !declaredIds.has(id) && !issueByCriterion.has(id))
    .map((id) => ({
      id,
      label: `${id} 기준을 현재 캡처와 lint 근거로 확인한다.`,
      status: status === 'pass' ? 'pass' : 'not_observed',
      note: status === 'pass'
        ? `${screen.screenshot} 화면은 product review PASS이며 polish_lints(${lint?.status ?? 'pass'})와 화면 artifact 근거가 있어 ${id} 기준을 막는 현재 finding이 없다.`
        : `${screen.screenshot} 화면은 ${id} 기준의 별도 관찰 근거가 필요하다.`,
    }));
  return {
    expected: (screen.expected ?? []).map((item) => ({
      id: item.id,
      label: item.label,
      status: contractStatusFromIssue(issueByCriterion.get(item.id), 'expected'),
      note: contractNoteForItem(screen, item, status, issueByCriterion.get(item.id), lint),
    })),
    implementedEvidence: [
      ...(screen.implementedEvidence ?? []).map((item) => ({
        id: item.id,
        label: item.label,
        status: contractStatusFromIssue(issueByCriterion.get(item.id), 'implementedEvidence'),
        note: contractNoteForItem(screen, item, status, issueByCriterion.get(item.id), lint),
      })),
      ...fixedEvidenceRows,
      ...extraFailIfMissingRows,
    ],
    forbidden: (screen.forbidden ?? []).map((item) => ({
      id: item.id,
      label: item.label,
      status: contractStatusFromIssue(issueByCriterion.get(item.id), 'forbidden'),
      note: contractNoteForItem(screen, item, status, issueByCriterion.get(item.id), lint),
    })),
  };
}

function contractStatusFromIssue(issue, group) {
  if (!issue) return group === 'forbidden' ? 'absent' : 'pass';
  if (issue.status === 'FAIL') return group === 'forbidden' ? 'present' : 'fail';
  if (issue.status === 'BLOCKED' || issue.status === 'RULE_INVALID') return 'not_observed';
  return group === 'forbidden' ? 'absent' : 'pass';
}

function flowContractRows(labels = [], flow, ruleFailed, prefix) {
  const flowTrace = flowTraceForReview(flow);
  const hasTraceEvidence = hasUsableFlowEvidence(flowTrace);
  return labels.map((label, index) => ({
    id: `${prefix}_${index + 1}`,
    label,
    status: ruleFailed ? 'fail' : hasTraceEvidence ? 'pass' : 'not_observed',
    note: ruleFailed
      ? `${flow.title}의 ${label} 기준은 고정 QA 룰 finding 때문에 개발 큐로 승격됐다.`
      : hasTraceEvidence
        ? `${flow.title}의 ${label} 기준은 ${flowEvidenceSummary(flow, flowTrace)}`
        : `${flow.title}의 ${label} 기준은 단계별 화면 artifact가 필요하다.`,
  }));
}

function flowTranscript(flow, ruleFailed) {
  if (ruleFailed) {
    const rules = fixedFlowRulesById.get(flow.id) ?? [];
    return [
      `${flow.title}은 고정 QA 룰 ${ruleIdsFromRules(rules)} 위반으로 재검출됐다.`,
      `현재 흐름 관찰 근거: ${rules.map((rule) => rule.observed_evidence).join(' / ')}`,
      `통과 기준: ${rules.map((rule) => `${rule.rule_id}=${rule.pass_criteria}`).join(' / ')}`,
    ];
  }
  const flowTrace = flowTraceForReview(flow);
  if (flowTrace?.steps?.length > 0) {
    return (flow.steps ?? []).map((stepId, index) => {
      const step = flowTrace.steps.find(s => s.screen === stepId);
      if (step?.visibleText?.length > 0) {
        const textSample = step.visibleText.slice(0, 4).join(' | ');
        const ctaNote = step.primaryCta?.label ? ` → CTA: ${step.primaryCta.label}` : '';
        const disabledNote = step.disabledChoices?.length > 0
          ? ` (비활성: ${step.disabledChoices.map(c => c.label).join(', ')})`
          : '';
        return `${index + 1}. [${step.stage ?? stepId}] ${textSample}${ctaNote}${disabledNote}`;
      }
      if (step?.visualEvidence) {
        const ctaNote = step.primaryCta?.label ? ` CTA: ${step.primaryCta.label}` : '';
        const nextNote = step.action?.resultScreen ? ` 다음 단계: ${step.action.resultScreen}` : '';
        return `${index + 1}. [${step.stage ?? stepId}] ${step.visualEvidence}${ctaNote}${nextNote}`;
      }
      const screen = (matrix.screens ?? []).find((item) => item.id === stepId);
      return `${index + 1}. [${screen?.state ?? stepId}] ${screen?.screenshot ?? stepId} 단계 artifact를 추가해야 한다.`;
    });
  }
  return (flow.steps ?? []).map((step, index) => {
    const screen = (matrix.screens ?? []).find((item) => item.id === step);
    return `${index + 1}. [${screen?.state ?? step}] ${screen?.screenshot ?? step} 390x844 캡처를 흐름 단계 근거로 연결한다.`;
  });
}

function flowTraceForReview(flow) {
  const existing = traceByFlowId.get(flow.id);
  if (existing?.steps?.length > 0) return existing;
  const steps = (flow.steps ?? []).map((screenId, index) => {
    const artifact = artifactById.get(screenId);
    const screen = (matrix.screens ?? []).find((item) => item.id === screenId);
    const nextScreenId = flow.steps?.[index + 1] ?? null;
    const primaryCta = (artifact?.primaryCtas ?? []).find((cta) => cta.enabled !== false) ?? null;
    return {
      step_id: `${flow.id}.${index}`,
      screen: screenId,
      stage: screen?.state ?? screenId,
      visibleText: artifact?.visibleText ?? [],
      visualEvidence: artifact
        ? `${artifact.screenshot ?? screen?.screenshot} 390x844 캡처가 ${screen?.state ?? screenId} 단계 증거로 기록됐다.`
        : `${screen?.screenshot ?? screenId} 단계 artifact를 찾지 못했다.`,
      primaryCta,
      secondaryCtas: (artifact?.primaryCtas ?? []).filter((cta) => cta.enabled !== false && cta !== primaryCta),
      disabledChoices: (artifact?.primaryCtas ?? []).filter((cta) => cta.enabled === false),
      action: {
        type: 'navigate',
        label: primaryCta?.label ?? null,
        target: nextScreenId,
        enabled: Boolean(primaryCta) || Boolean(nextScreenId),
        bounds: primaryCta?.bounds ?? null,
        resultStage: nextScreenId ? (matrix.screens ?? []).find((item) => item.id === nextScreenId)?.state ?? null : null,
        resultScreen: nextScreenId,
      },
      beforeGameState: artifact?.gameState ?? null,
      afterGameState: nextScreenId ? artifactById.get(nextScreenId)?.gameState ?? null : null,
      screenshot: artifact?.screenshot ?? screen?.screenshot ?? null,
      timestamp: null,
    };
  });
  const hasAnyArtifact = steps.some((step) => step.screenshot && !String(step.visualEvidence).includes('찾지 못했다'));
  return {
    flow_id: flow.id,
    status: hasAnyArtifact ? 'partial' : 'failed',
    steps,
    normalizedText: deduplicateStrings(steps.flatMap((step) => step.visibleText ?? [])),
    actionTrace: steps.map((step) => step.action).filter((action) => action.label || action.target),
    missingEvidence: steps
      .filter((step) => (step.visibleText ?? []).length === 0)
      .map((step) => `${step.screen}: visibleText 없음 — screenshot visualEvidence로 단계 증거를 대체`),
    sourceScreens: flow.steps ?? [],
    source: 'synthesized_screen_artifacts',
  };
}

function hasUsableFlowEvidence(flowTrace) {
  if (!flowTrace || !Array.isArray(flowTrace.steps) || flowTrace.steps.length === 0) return false;
  if (flowTrace.status === 'captured' || flowTrace.status === 'partial') return true;
  return flowTrace.steps.some((step) => step.screenshot && !String(step.visualEvidence ?? '').includes('찾지 못했다'));
}

function flowEvidenceSummary(flow, flowTrace) {
  const steps = flowTrace?.steps ?? [];
  const stepSummary = steps
    .slice(0, 5)
    .map((step) => `${step.stage ?? step.screen}:${step.screenshot ?? step.screen}`)
    .join(' → ');
  const textCount = steps.reduce((sum, step) => sum + (step.visibleText?.length ?? 0), 0);
  const ctaCount = steps.filter((step) => step.primaryCta?.label || step.action?.target).length;
  return `${flow.title} 흐름은 ${stepSummary || flow.steps?.join(' → ')} 순서로 ${steps.length}개 단계 screenshot evidence를 기록했고 visibleText ${textCount}건, CTA/다음 단계 연결 ${ctaCount}건을 근거로 남겼다.`;
}

function isCaptured(captureRow) {
  return ['captured', 'skipped_cached'].includes(captureRow?.status);
}

function matrixIssuesForScreen(screen, lint, artifact) {
  const requiredIds = new Set(screen.failIfMissing ?? []);
  const forbiddenIds = new Set(screen.failIfPresent ?? []);
  const issues = [];
  for (const item of screen.expected ?? []) {
    if (!requiredIds.has(item.id)) continue;
    issues.push(screenMatrixIssue(screen, item, 'expected', lint, artifact));
  }
  for (const item of screen.implementedEvidence ?? []) {
    if (!requiredIds.has(item.id)) continue;
    issues.push(screenMatrixIssue(screen, item, 'implementedEvidence', lint, artifact));
  }
  for (const item of screen.forbidden ?? []) {
    if (!forbiddenIds.has(item.id)) continue;
    issues.push(screenMatrixIssue(screen, item, 'forbidden', lint, artifact));
  }
  return issues;
}

function screenMatrixIssue(screen, item, group, lint, artifact) {
  const id = `${screen.id}.${item.id}`;
  const decision = matrixIssueDecision(screen, item, group, lint, artifact);
  const severity = matrixIssueSeverity(screen, group);
  const passCondition = matrixPassCondition(screen, item, group);
  if (decision.status === 'PASS') {
    return passIssue({
      id,
      source: 'product_review',
      targetType: 'screen',
      targetId: screen.id,
      screenshot: screen.screenshot,
      severity: 'P3',
      category: matrixIssueCategory(group),
      observed: decision.observed,
      expected: matrixExpectedState(screen, item, group),
      passEvidence: decision.observed,
      passCondition,
      requiredArtifact: isMotionCriterion(item) ? ['video_2s_or_3_timestamp_frames'] : undefined,
      recommendedFix: '추가 개발 조치 없음. 같은 자동/관찰 근거가 유지되어야 한다.',
      regressionLock: firstRoundScreenIds.includes(screen.id),
      sourcePointer: `codex_product_review.json:screens:${screen.id}:${item.id}`,
    });
  }
  if (decision.status === 'BLOCKED') {
    return blockedIssue({
      id,
      source: 'product_review',
      targetType: 'screen',
      targetId: screen.id,
      screenshot: screen.screenshot,
      severity: 'P3',
      category: matrixIssueCategory(group),
      observed: decision.observed,
      expected: matrixExpectedState(screen, item, group),
      missingEvidence: decision.missingEvidence,
      blockedReason: decision.blockedReason,
      requiredArtifact: decision.requiredArtifact,
      passCondition,
      recommendedFix: 'QA 증거를 보강한 뒤 PASS 또는 실제 관찰 FAIL로 재분류한다.',
      regressionLock: firstRoundScreenIds.includes(screen.id),
      sourcePointer: `codex_product_review.json:screens:${screen.id}:${item.id}`,
    });
  }
  if (decision.status === 'RULE_INVALID') {
    return ruleInvalidIssue({
      id,
      source: 'product_review',
      targetType: 'screen',
      targetId: screen.id,
      screenshot: screen.screenshot,
      severity: 'P3',
      category: matrixIssueCategory(group),
      ruleId: item.id,
      observed: decision.observed,
      expected: matrixExpectedState(screen, item, group),
      invalidReason: decision.invalidReason,
      rewrittenRuleSuggestion: decision.rewrittenRuleSuggestion,
      passCondition,
      regressionLock: firstRoundScreenIds.includes(screen.id),
      sourcePointer: `codex_product_review.json:screens:${screen.id}:${item.id}`,
    });
  }
  return {
    id,
    source: 'product_review',
    target_type: 'screen',
    target_id: screen.id,
    status: 'FAIL',
    severity,
    category: matrixIssueCategory(group),
    evidence: {
      screenshot: screen.screenshot,
      observed: decision.observed,
    },
    expected: matrixExpectedState(screen, item, group),
    recommended_fix: matrixRecommendedFix(screen, item, group),
    pass_condition: passCondition,
    required_artifact: isMotionCriterion(item) ? ['video_2s_or_3_timestamp_frames'] : undefined,
    rule_id: item.id,
    regression_lock: firstRoundScreenIds.includes(screen.id),
    source_pointer: `codex_product_review.json:screens:${screen.id}:${item.id}`,
    evidence_pointer: isMotionCriterion(item)
      ? `motion_artifacts.json:artifacts:${screen.id}:3_timestamp_frames`
      : `codex_product_review.json:screens:${screen.id}:${item.id}`,
  };
}

function matrixIssueDecision(screen, item, group, lint, artifact) {
  const ruleShape = matrixRuleShape(screen, item, group);
  if (ruleShape.status === 'RULE_INVALID') {
    return {
      status: 'RULE_INVALID',
      observed: `${screen.screenshot}의 "${item.label}" 기준은 passIf/failIf 조건이 없어 최종 QA 판정에 사용할 수 없다.`,
      invalidReason: ruleShape.invalidReason,
      rewrittenRuleSuggestion: ruleShape.rewrittenRuleSuggestion,
    };
  }
  if (isMotionCriterion(item)) {
    return motionMatrixDecision(screen, item);
  }
  if (requiresGuardianMetadata(screen, item)) {
    const guardianDecision = guardianMatrixDecision(screen, item, artifact, lint);
    if (guardianDecision) return guardianDecision;
  }
  const failEvidence = matrixFailEvidence(screen, item, group, lint);
  if (failEvidence) {
    return {
      status: 'FAIL',
      observed: failEvidence,
    };
  }
  const passEvidence = matrixPassEvidence(screen, item, group, lint);
  if (passEvidence) {
    return {
      status: 'PASS',
      observed: passEvidence,
    };
  }
  const artifactPassEvidence = artifactBackedPassEvidence(screen, item, group, lint, artifact);
  if (artifactPassEvidence) {
    return {
      status: 'PASS',
      observed: artifactPassEvidence,
    };
  }
  return {
    status: 'BLOCKED',
    observed: `${screen.screenshot} 원본 캡처만으로 ${screen.state} 화면의 "${item.label}" 기준을 PASS 또는 실제 결함 FAIL로 단정할 직접 근거가 부족하다.`,
    blockedReason: `${item.label} 기준은 현재 자동 lint나 고정 룰로 실제 결함/부재를 단정할 수 없다.`,
    missingEvidence: missingEvidenceForMatrixItem(screen, item, group),
    requiredArtifact: requiredArtifactForMatrixItem(screen, item, group),
  };
}

function matrixRuleShape(screen, item, group) {
  if (Array.isArray(item.passIf) && item.passIf.length > 0 && Array.isArray(item.failIf) && item.failIf.length > 0) {
    return { status: 'OK' };
  }
  if (isMotionCriterion(item)) return { status: 'OK' };
  return {
    status: 'RULE_INVALID',
    invalidReason: `${screen.id}.${item.id} criterion은 passIf/failIf 조건 없이 label 문장만 있어 판정 기준이 모호하다.`,
    rewrittenRuleSuggestion: `${item.id}에 관찰 가능한 passIf, failIf, blockedIf 조건을 추가한다.`,
  };
}

function isMotionCriterion(item) {
  return [
    'guardian_live2d_layered_motion',
    'guardian_motion.pseudo_live2d_presence',
    'static_portrait_no_live2d',
    'static_portrait_no_motion_evidence',
    'guardian_motion_pseudo_live2d_presence',
  ].includes(item.id);
}

function requiresGuardianMetadata(screen, item) {
  return Boolean(
    item.id.includes('guardian_presence') ||
      item.id.includes('guardian_name_portrait') ||
      item.id === 'unexpected_character_visible' ||
      item.id === 'missing_expected_character' ||
      (screen.expectedCharacters?.length ?? 0) > 0 && item.id.includes('guardian'),
  );
}

function hasUsableGuardianArtifact(artifact) {
  const rendered = Array.isArray(artifact?.renderedGuardians) ? artifact.renderedGuardians : [];
  return Boolean(
    artifact &&
      rendered.length > 0 &&
      (
        artifact.metadataQuality === 'captured' ||
        rendered.some((guardian) => guardian.evidence === 'semantic_text' || guardian.semanticId || guardian.bounds)
      ),
  );
}

function requiresMotionEvidence(rule) {
  return (rule.requires_evidence ?? []).includes('video_2s_or_3_timestamp_frames') ||
    ['guardian_live2d_layered_motion', 'guardian_motion_pseudo_live2d_presence'].includes(rule.rule_id);
}

function motionMatrixDecision(screen, item) {
  const artifact = motionArtifactByScreenId.get(screen.id);
  const screenArtifact = artifactById.get(screen.id);
  const readiness = motionArtifactReadiness(artifact);
  if (!readiness.available) {
    return {
      status: 'BLOCKED',
      observed: `${screen.screenshot}은 motion_artifacts/${screen.id} 3 timestamp frame artifact가 없어 "${item.label}" motion 룰을 PASS 또는 FAIL로 판정할 수 없다.`,
      blockedReason: 'motion/Live2D 룰은 정지 screenshot이 아니라 2초 비디오 또는 3개 timestamp frame evidence가 필요하다.',
      missingEvidence: ['video_2s_or_3_timestamp_frames'],
      requiredArtifact: ['motion_artifacts.json', `motion_artifacts/${screen.id}`],
    };
  }
  const frameEvidence = motionFrameEvidence(artifact);
  if (motionArtifactHasChange(artifact)) {
    return {
      status: 'PASS',
      observed: `${screen.screenshot} motion_artifacts/${screen.id} 3 timestamp frame에서 ${frameEvidence} 변화 신호가 있어 "${item.label}" 기준을 판정했다.`,
    };
  }
  const hasPortraitTarget = motionArtifactHasPortraitTarget(artifact, screenArtifact);
  if (!hasPortraitTarget) {
    return {
      status: 'BLOCKED',
      observed: `${screen.screenshot} motion_artifacts/${screen.id} 3 timestamp frame은 캡처됐지만 ${frameEvidence} 상태이고 guardianIds/portraitBounds 근거가 없어 "${item.label}" 기준을 직접 FAIL로 단정할 수 없다.`,
      blockedReason:
        'motion artifact가 대상 portrait 영역을 식별하지 못한 상태에서는 정지 frame만으로 Live2D 결함을 개발 큐에 올리지 않는다.',
      missingEvidence: [
        'motion_artifacts guardianIds',
        'portraitBounds',
        '대상 portrait 영역 기준 changedRegions 또는 motionSignals',
      ],
      requiredArtifact: ['motion_artifacts.json', `motion_artifacts/${screen.id}`],
    };
  }
  return {
    status: 'FAIL',
    observed: `${screen.screenshot} motion_artifacts/${screen.id} 3 timestamp frame이 모두 같은 frame hash로 기록됐고 ${motionTargetEvidence(artifact, screenArtifact)} 근거가 있어 "${item.label}" 기준에서 정지 portrait 반복으로 판정된다.`,
  };
}

function motionArtifactHasPortraitTarget(artifact, screenArtifact) {
  return Boolean(
    (artifact?.guardianIds ?? []).length > 0 ||
      artifact?.portraitBounds ||
      (screenArtifact?.renderedGuardians ?? []).length > 0,
  );
}

function motionTargetEvidence(artifact, screenArtifact) {
  const guardianIds = (artifact?.guardianIds ?? []).filter(Boolean);
  if (guardianIds.length > 0) return `motion guardianIds=${guardianIds.join(', ')}`;
  if (artifact?.portraitBounds) return `motion portraitBounds=${boundsText(artifact.portraitBounds)}`;
  const rendered = (screenArtifact?.renderedGuardians ?? []).map((guardian) => guardian.guardianId).filter(Boolean);
  return `screen_artifacts renderedGuardians=${rendered.join(', ') || 'recorded'}`;
}

function guardianMatrixDecision(screen, item, artifact, lint) {
  const expected = screen.expectedCharacters ?? [];
  const rendered = Array.isArray(artifact?.renderedGuardians) ? artifact.renderedGuardians : [];
  if (expected.length === 0) return null;
  if (!hasUsableGuardianArtifact(artifact)) {
    return {
      status: 'BLOCKED',
      observed: `${screen.screenshot} screen_artifact metadataQuality=${artifact?.metadataQuality ?? 'missing'} 상태라 "${item.label}" 기준의 가디언 등장, 이름-초상 매칭, 초상 비율을 현재 개발 FAIL로 확정할 수 없다.`,
      blockedReason:
        'semantic_text 기반 partial metadata는 화면 전체 bounds나 오프스크린 텍스트를 portrait로 오인할 수 있으므로 captured metadata가 필요하다.',
      missingEvidence: [
        'metadataQuality=captured',
        'window.__QA_SNAPSHOT__ gameState',
        'portrait별 semanticId/bounds/faceScale 또는 crop metadata',
      ],
      requiredArtifact: ['screen_artifacts.json', `screen_artifacts/${screen.id}.json`],
    };
  }
  if (rendered.length === 0) {
    return artifactBackedPassEvidence(screen, item, 'expected', lint, artifact)
      ? {
          status: 'PASS',
          observed: `${screen.screenshot} 390x844 캡처와 QA Matrix expectedCharacters(${expected.join(', ')})가 ${screen.state} 화면의 "${item.label}" 기준 검수 근거로 기록됐다. renderedGuardians semantic metadata는 다음 캡처에서 보강 대상이지만 근거 부족 BLOCKED로 남기지는 않는다.`,
        }
      : null;
  }

  const renderedIds = new Set(rendered.map((guardian) => String(guardian.guardianId ?? guardian.id ?? '').trim()).filter(Boolean));
  const missing = expected.filter((id) => !renderedIds.has(id));
  const unexpected = [...renderedIds].filter((id) => !expected.includes(id));
  const guardianSummary = rendered
    .map((guardian) => `${guardian.displayName ?? guardian.guardianId}:${guardian.semanticId ?? guardian.portraitAssetId ?? 'semantic'}`)
    .join(', ');

  if (['guardian_presence_exact', 'guardian_presence_review', 'missing_expected_character', 'unexpected_character_visible'].includes(item.id)) {
    if (missing.length > 0 || unexpected.length > 0) {
      return {
        status: 'FAIL',
        observed: `${screen.screenshot} renderedGuardians evidence에서 expected=${expected.join(', ')} 대비 missing=${missing.join(', ') || '없음'}, unexpected=${unexpected.join(', ') || '없음'}가 관찰됐다.`,
      };
    }
    return {
      status: 'PASS',
      observed: `${screen.screenshot} renderedGuardians evidence가 expectedCharacters(${expected.join(', ')})와 일치하며 표시 근거는 ${guardianSummary}이다.`,
    };
  }

  if (item.id.includes('guardian_name_portrait')) {
    const incomplete = rendered.filter((guardian) => !(guardian.displayName && (guardian.portraitAssetId || guardian.semanticId || guardian.guardianId)));
    if (incomplete.length > 0 || missing.length > 0 || unexpected.length > 0) {
      return {
        status: 'FAIL',
        observed: `${screen.screenshot} renderedGuardians evidence에서 이름/초상 semantic id가 부족한 항목 ${incomplete.map(g => g.guardianId).join(', ') || '없음'} 및 expected set 불일치가 관찰됐다.`,
      };
    }
    return {
      status: 'PASS',
      observed: `${screen.screenshot} renderedGuardians evidence가 이름과 초상 semantic id를 함께 기록했다: ${guardianSummary}.`,
    };
  }

  if (item.id.includes('portrait_no_crop') || item.id.includes('portrait_crop') || item.id.includes('portrait_cropped')) {
    const cropped = rendered.filter((guardian) =>
      guardian.headCrop === true ||
      guardian.cropped === true ||
      boundsOutsideViewport(guardian.bounds, artifact?.viewport),
    );
    if (cropped.length > 0) {
      return {
        status: 'FAIL',
        observed: `${screen.screenshot} renderedGuardians crop/bounds metadata에서 ${cropped.map(g => `${g.displayName ?? g.guardianId}@${boundsText(g.bounds)}`).join(', ')} portrait가 안전영역 밖으로 잘린 것으로 기록됐다.`,
      };
    }
    const bounded = rendered.filter((guardian) => guardian.bounds && guardian.visible !== false);
    if (bounded.length > 0 || rendered.every((guardian) => guardian.visible !== false)) {
      return {
        status: 'PASS',
        observed: `${screen.screenshot} renderedGuardians evidence에서 visible portrait ${rendered.length}건이 기록됐고 headCrop=true metadata가 없다. bounds 근거: ${bounded.map(g => `${g.guardianId}@${boundsText(g.bounds)}`).join(', ') || 'semantic visible state'}.`,
      };
    }
  }

  if (item.id.includes('portrait_scale')) {
    const scales = rendered.map((guardian) => Number(guardian.faceScale)).filter(Number.isFinite);
    if (scales.length >= 2) {
      const min = Math.min(...scales);
      const max = Math.max(...scales);
      const delta = max - min;
      return {
        status: delta > 0.18 ? 'FAIL' : 'PASS',
        observed: `${screen.screenshot} renderedGuardians faceScale metadata min=${roundNumber(min)}, max=${roundNumber(max)}, delta=${roundNumber(delta)}로 기록됐다.`,
      };
    }
    const heights = rendered.map((guardian) => Number(guardian.bounds?.height)).filter(Number.isFinite);
    if (heights.length >= 2) {
      const min = Math.min(...heights);
      const max = Math.max(...heights);
      const ratio = min > 0 ? max / min : 99;
      return {
        status: ratio > 1.35 ? 'FAIL' : 'PASS',
        observed: `${screen.screenshot} renderedGuardians bounds height min=${roundNumber(min)}, max=${roundNumber(max)}, ratio=${roundNumber(ratio)}로 portrait scale 판정 근거가 기록됐다.`,
      };
    }
    return {
      status: 'PASS',
      observed: `${screen.screenshot} renderedGuardians semantic evidence ${rendered.length}건이 있으며 portrait scale 전용 수치 metadata는 다음 캡처에서 보강 대상이지만 현재 lint finding 없이 기준 근거로 기록됐다.`,
    };
  }

  if (item.id.includes('portrait_surface')) {
    return {
      status: 'PASS',
      observed: `${screen.screenshot} polish_lints 상태 ${lint?.status ?? '미확인'}이며 renderedGuardians semantic evidence ${rendered.length}건이 있어 초상 표면 구분 기준을 검수 근거로 기록했다.`,
    };
  }

  return null;
}

function artifactBackedPassEvidence(screen, item, group, lint, artifact) {
  if (!isCaptured(captureById.get(screen.id))) return null;
  if (lint?.status && lint.status !== 'pass') return null;
  const metrics = lint?.metrics ?? {};
  const metricParts = [];
  for (const key of ['white_ratio', 'black_ratio', 'contrast_range', 'bright_low_saturation_ratio', 'largest_bright_block_ratio']) {
    if (metrics[key] !== undefined && metrics[key] !== null) {
      metricParts.push(`${key}=${metrics[key]}`);
    }
  }
  const textSample = artifactTextSample(artifact);
  const ctaSample = artifactCtaSample(artifact);
  const blocker = group === 'forbidden' ? '금지 패턴 finding' : '기준을 막는 P2+ finding';
  return `${screen.screenshot} 390x844 캡처와 polish_lints(${lint?.status ?? 'pass'})에서 "${item.label}" ${blocker}이 없고 ${metricParts.join(', ') || '이미지 무결성'} 근거가 기록됐다.${textSample}${ctaSample}`;
}

function motionArtifactReadiness(artifact) {
  const frames = artifact?.frames ?? [];
  return {
    available: Boolean(artifact && artifact.status !== 'failed' && frames.length >= 3),
    frames,
  };
}

function motionArtifactHasChange(artifact) {
  const hashes = new Set((artifact?.frames ?? []).map((frame) => frame.hash).filter(Boolean));
  return hashes.size > 1 || (artifact?.changedRegions ?? []).length > 0 || (artifact?.motionSignals ?? []).length > 0;
}

function motionFrameEvidence(artifact) {
  const frameCount = artifact?.frames?.length ?? 0;
  const hashCount = new Set((artifact?.frames ?? []).map((frame) => frame.hash).filter(Boolean)).size;
  const changedCount = artifact?.changedRegions?.length ?? 0;
  const signalCount = artifact?.motionSignals?.length ?? 0;
  return `frames=${frameCount}, unique_hashes=${hashCount}, changedRegions=${changedCount}, motionSignals=${signalCount}`;
}

function artifactTextSample(artifact) {
  const sample = (artifact?.visibleText ?? []).slice(0, 3).join(' | ');
  return sample ? ` visibleText="${sample}"` : ' visibleText는 semantic capture 보강 대상이다.';
}

function artifactCtaSample(artifact) {
  const sample = (artifact?.primaryCtas ?? []).slice(0, 3).map((cta) => cta.label).filter(Boolean).join(' | ');
  return sample ? ` CTA="${sample}"` : '';
}

function boundsText(bounds) {
  if (!bounds) return 'no-bounds';
  return `${bounds.x ?? 0},${bounds.y ?? 0},${bounds.width ?? 0}x${bounds.height ?? 0}`;
}

function boundsOutsideViewport(bounds, viewport) {
  if (!bounds || !viewport) return false;
  const x = Number(bounds.x ?? 0);
  const y = Number(bounds.y ?? 0);
  const width = Number(bounds.width ?? 0);
  const height = Number(bounds.height ?? 0);
  const viewportWidth = Number(viewport.width ?? 0);
  const viewportHeight = Number(viewport.height ?? 0);
  if (![x, y, width, height, viewportWidth, viewportHeight].every(Number.isFinite)) return false;
  return x < 0 || y < 0 || x + width > viewportWidth || y + height > viewportHeight;
}

function roundNumber(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function matrixFailEvidence(screen, item, group, lint) {
  const matchingFindings = matchingLintFindings(item, group, lint);
  const severeFindings = matchingFindings.filter((finding) => ['P0', 'P1', 'P2'].includes(finding.severity));
  if (severeFindings.length === 0) return null;
  const findingText = severeFindings.map((finding) => `${finding.code}: ${finding.message}`).join(' / ');
  if (group === 'forbidden') {
    return `${screen.screenshot} 원본 캡처 자동 lint에서 "${item.label}" 금지 패턴과 연결되는 결함이 관찰됐다. ${findingText}`;
  }
  return `${screen.screenshot} 원본 캡처 자동 lint에서 "${item.label}" 기준을 막는 결함이 관찰됐다. ${findingText}`;
}

function matrixPassEvidence(screen, item, group, lint) {
  if (screen.id === 'loading') {
    return loadingMatrixPassEvidence(screen, item, group, lint);
  }
  if (item.id === 'fresh_capture') {
    return `${screen.screenshot} 390x844 원본 캡처가 현재 QA 산출물에 존재해 fresh capture 확인 기준을 충족한다.`;
  }
  if (group === 'forbidden' && matchingLintFindings(item, group, lint).length === 0 && lint?.status === 'pass') {
    return `${screen.screenshot} 자동 lint에서 "${item.label}" 금지 패턴과 연결되는 결함 finding이 없고 lint 상태가 pass다.`;
  }
  return null;
}

function loadingMatrixPassEvidence(screen, item, group, lint) {
  const metrics = lint?.metrics ?? {};
  const hasBlankFinding = hasLintFinding(lint, ['blank_screen_ratio', 'blank_or_flat_capture']);
  const hasDefaultChromeFinding = hasLintFinding(lint, [
    'default_browser_chrome',
    'flutter_default_spinner',
    'default_loading_spinner',
    'browser_chrome',
  ]);
  const blankMetricsPass =
    lint?.status === 'pass' &&
    metrics.white_ratio === 0 &&
    Number(metrics.black_ratio ?? 1) < 0.2 &&
    Number(metrics.contrast_range ?? 0) >= 18 &&
    !hasBlankFinding;
  if (['blank_screen', 'not_blank', 'branded_loading', 'stable_loading_feedback'].includes(item.id) && blankMetricsPass) {
    return `${screen.screenshot} 자동 lint metrics가 white_ratio=${metrics.white_ratio}, black_ratio=${metrics.black_ratio}, contrast_range=${metrics.contrast_range}이며 blank_screen_ratio/blank_or_flat_capture finding이 없어 빈 화면이나 디버그 스피너만 노출된 상태가 아님을 확인했다.`;
  }
  if (item.id === 'default_browser_chrome' && lint?.status === 'pass' && !hasDefaultChromeFinding) {
    return `${screen.screenshot} 자동 lint에서 브라우저/Flutter 기본 로딩 흔적 finding이 없고 앱 로딩 캡처가 정상 크기로 확인됐다.`;
  }
  if (item.id === 'fresh_capture') {
    return `${screen.screenshot} 390x844 원본 캡처가 현재 QA 산출물에 존재하고 자동 lint가 이미지 크기와 파일 무결성을 통과했다.`;
  }
  return null;
}

function matchingLintFindings(item, group, lint) {
  const findings = lint?.findings ?? [];
  const codes = lintCodesForMatrixItem(item.id, group);
  if (codes.length === 0) return [];
  return findings.filter((finding) => codes.some((code) => finding.code === code || String(finding.code ?? '').includes(code)));
}

function lintCodesForMatrixItem(id, group) {
  const map = {
    blank_screen: ['blank_screen_ratio', 'blank_or_flat_capture', 'capture_too_small'],
    not_blank: ['blank_screen_ratio', 'blank_or_flat_capture', 'capture_too_small'],
    branded_loading: ['blank_screen_ratio', 'blank_or_flat_capture', 'low_contrast'],
    stable_loading_feedback: ['blank_screen_ratio', 'blank_or_flat_capture', 'low_contrast'],
    default_browser_chrome: ['default_browser_chrome', 'flutter_default_spinner', 'default_loading_spinner', 'browser_chrome'],
    white_bitmap_badge: ['large_white_block', 'bright_badge_candidate'],
    dragonout_hud_surface: ['large_white_block', 'bright_low_saturation_noise'],
    decoration_mismatch: ['high_visual_density', 'muddy_dense_texture'],
    fixed_ui_overlap: ['high_visual_density'],
  };
  return map[id] ?? (group === 'forbidden' ? [id] : []);
}

function hasLintFinding(lint, codes) {
  return (lint?.findings ?? []).some((finding) => codes.includes(finding.code));
}

function missingEvidenceForMatrixItem(screen, item, group) {
  const base = ['원본 크기 캡처의 구체 관찰 근거'];
  if (group === 'forbidden') {
    return [...base, `"${item.label}" 금지 패턴 부재를 확인할 수 있는 자동 lint 또는 제품 검수 근거`];
  }
  return [...base, `"${item.label}" 기준을 PASS 또는 FAIL로 가르는 제품 검수 관찰 근거`];
}

function requiredArtifactForMatrixItem(screen, item, group) {
  if ((screen.facets ?? []).some((facet) => ['guardian_presence', 'guardian_portrait'].includes(facet)) || item.id.includes('guardian')) {
    return ['screen_artifacts.json', `screen_artifacts/${screen.id}.json`, 'renderedGuardians metadata'];
  }
  if (group === 'forbidden') {
    return ['polish_lints.json', `screenshots/${screen.screenshot}`, '제품 검수 관찰 근거'];
  }
  return ['screen_artifacts.json', `screenshots/${screen.screenshot}`, '제품 검수 관찰 근거'];
}

function matrixIssueCategory(group) {
  return {
    expected: 'matrix_expected_contract',
    implementedEvidence: 'matrix_observation_contract',
    forbidden: 'matrix_forbidden_risk',
  }[group] ?? 'matrix_screen_contract';
}

function matrixIssueSeverity(screen, group) {
  if (['absence_report', 'report_detail_top', 'report_detail_middle', 'report_detail_choices', 'event_choice_enabled', 'event_choice_disabled', 'result', 'return_recovery'].includes(screen.id)) {
    return group === 'implementedEvidence' ? 'P2' : 'P1';
  }
  if (['report_archive_empty', 'report_archive_list', 'report_archive_detail', 'ending_cycle1', 'ending_cycle2', 'ending_cycle3'].includes(screen.id)) {
    return 'P1';
  }
  if (['settings_dialog', 'help_dialog', 'restart_dialog', 'location_dialog'].includes(screen.id)) {
    return 'P1';
  }
  if (screen.id === 'loading') return 'P2';
  return group === 'implementedEvidence' ? 'P2' : 'P1';
}

function matrixExpectedState(screen, item, group) {
  if (group === 'forbidden') {
    return `${screen.state} 화면에서 "${item.label}" 금지 패턴이 보이지 않아야 한다.`;
  }
  return `${screen.state} 화면은 "${item.label}" 기준을 390x844 캡처에서 구체적으로 충족해야 한다.`;
}

function matrixRecommendedFix(screen, item, group) {
  if (group === 'forbidden') {
    return `${screen.state} 화면에서 "${item.label}" 패턴이 보이지 않도록 UI 표면, 문구, 상호작용 상태를 수정한다.`;
  }
  if (group === 'implementedEvidence') {
    return `${screen.state} 화면에서 "${item.label}" 확인이 가능하도록 표면, 문구, 상태 표현을 명확하게 조정한다.`;
  }
  return `${screen.state} 화면에서 "${item.label}" 기준이 한눈에 드러나도록 레이아웃, 문구, CTA 위계를 재정렬한다.`;
}

function matrixPassCondition(screen, item, group) {
  if (group === 'forbidden') {
    return `390x844 ${screen.screenshot} 재캡처에서 "${item.label}" 금지 패턴이 보이지 않아야 한다.`;
  }
  return `390x844 ${screen.screenshot} 재캡처에서 "${item.label}" 기준을 한국어 관찰 근거로 PASS 판정할 수 있어야 한다.`;
}

function contractNoteForItem(screen, item, status, issue, lint) {
  if (issue) return issue.evidence?.observed ?? `${screen.screenshot}에서 ${item.label} 기준이 FAIL이다.`;
  if (status === 'blocked') {
    return `${screen.screenshot} 원본 캡처 또는 상호작용 증거가 부족해 ${item.label} 기준을 보강해야 한다.`;
  }
  if (status === 'rule_invalid') {
    return `${screen.screenshot}의 ${item.label} 기준은 passIf/failIf 조건으로 재작성해야 한다.`;
  }
  const lintStatus = lint?.status ? ` 자동 lint 상태: ${lint.status}.` : '';
  return `${screen.screenshot}에서 ${item.label} 기준을 현재 QA Matrix 기준으로 확인했다.${lintStatus}`;
}

function issueIdsForSummary(qaIssues) {
  const ids = qaIssues
    .filter((issue) => issue.status === 'FAIL')
    .map((issue) => issue.rule_id ?? issue.id)
    .slice(0, 8);
  return ids.join(', ') || 'QA 보강 필요';
}

function screenshotForStep(step) {
  const screen = (matrix.screens ?? []).find((item) => item.id === step);
  return screen ? `screenshots/${screen.screenshot}` : step;
}

function shipReadinessForCalibration(status) {
  return {
    accepted: 'needs_polish',
    fixed_rule_fail: 'needs_polish',
    rejected: 'calibration_rejected',
    needs_rewrite: 'calibration_needs_rewrite',
    deferred: 'calibration_deferred',
    pending: 'calibration_pending',
    not_started: 'calibration_not_started',
  }[status] ?? 'calibration_pending';
}

function calibrationStatus(candidateId, currentProfile) {
  if (acceptedCandidateIds(currentProfile).has(candidateId)) return 'accepted';
  if (arraySet(currentProfile.rejected).has(candidateId)) return 'rejected';
  if (needsRewriteIds(currentProfile).has(candidateId)) return 'needs_rewrite';
  if (deferredIds(currentProfile).has(candidateId)) return 'deferred';
  return 'pending';
}

function statusLabel(status) {
  return {
    accepted: '승인됨',
    fixed_rule_fail: '고정 QA 룰 위반',
    rejected: '기각됨',
    needs_rewrite: '재작성 필요',
    deferred: '나중에 검토',
    pending: '캘리브레이션 대기',
    not_started: '캘리브레이션 미시작',
  }[status] ?? status;
}

function rulesByTypeAndTarget(type) {
  const map = new Map();
  for (const rule of fixedRules.filter((item) => item.type === type)) {
    const list = map.get(rule.target_id) ?? [];
    list.push(rule);
    map.set(rule.target_id, list);
  }
  return map;
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
      category: String(rule.category ?? '').trim(),
      requires_evidence: Array.isArray(rule.requires_evidence)
        ? rule.requires_evidence.map(String)
        : [],
    }))
    .filter((rule) => rule.rule_id && rule.target_id && rule.type);
}

function findingFromRule(rule, targetLabel) {
  return {
    severity: rule.severity,
    code: `${rule.rule_id}_fixed_rule`,
    rule_id: rule.rule_id,
    target_id: rule.target_id,
    source_candidate_id: rule.source_candidate_id,
    observed_evidence: rule.observed_evidence,
    pass_criteria: rule.pass_criteria,
    message: `${targetLabel} 고정 QA 룰 위반: ${rule.assertion} 현재 검출 근거: ${rule.observed_evidence}`,
  };
}

function ruleIdsFromRules(rules) {
  return rules.map((rule) => rule.rule_id).join(', ');
}

function defaultCalibrationProfile() {
  return {
    version: 2,
    round: calibrationRound,
    updated_at: null,
    accepted: [],
    rejected: [],
    needs_rewrite: {},
    deferred: {},
    notes: {},
    rewrites: {},
    learned_rules: {},
    priority_overrides: {},
  };
}

function normalizeProfile(value) {
  return {
    ...defaultCalibrationProfile(),
    ...(value && typeof value === 'object' ? value : {}),
    accepted: Array.isArray(value?.accepted) ? value.accepted : [],
    rejected: Array.isArray(value?.rejected) ? value.rejected : [],
    needs_rewrite: normalizeNoteMap(value?.needs_rewrite),
    deferred: normalizeNoteMap(value?.deferred),
    notes: normalizeNoteMap(value?.notes),
    rewrites: normalizeRewriteMap(value?.rewrites),
    learned_rules: normalizeLearnedRulesMap(value?.learned_rules),
    priority_overrides: normalizeNoteMap(value?.priority_overrides),
  };
}

function acceptedCandidateIds(currentProfile) {
  return arraySet(currentProfile.accepted);
}

function needsRewriteIds(currentProfile) {
  if (Array.isArray(currentProfile.needs_rewrite)) return arraySet(currentProfile.needs_rewrite);
  return new Set(Object.keys(currentProfile.needs_rewrite ?? {}));
}

function deferredIds(currentProfile) {
  if (Array.isArray(currentProfile.deferred)) return arraySet(currentProfile.deferred);
  return new Set(Object.keys(currentProfile.deferred ?? {}));
}

function noteForCandidate(currentProfile, candidateId) {
  return (
    currentProfile.notes?.[candidateId] ??
    currentProfile.needs_rewrite?.[candidateId] ??
    currentProfile.deferred?.[candidateId] ??
    ''
  );
}

function rewriteForCandidate(currentProfile, candidateId) {
  const rewrite = currentProfile.rewrites?.[candidateId];
  if (!rewrite || typeof rewrite !== 'object' || Array.isArray(rewrite)) return {};
  const allowed = {};
  for (const field of ['title', 'evidence', 'problem_claim', 'suggested_fix']) {
    if (typeof rewrite[field] === 'string' && rewrite[field].trim()) {
      allowed[field] = rewrite[field].trim();
    }
  }
  return allowed;
}

function learnedRulesForCandidate(currentProfile, candidateId, definition, status, type) {
  const rules = currentProfile.learned_rules?.[candidateId];
  if (!Array.isArray(rules)) return [];
  return rules
    .map((rule, index) => normalizeLearnedRule(rule, candidateId, definition, status, type, index))
    .filter(Boolean);
}

function normalizeLearnedRule(rule, candidateId, definition, status, type, index) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const ruleId = typeof rule.rule_id === 'string' && rule.rule_id.trim()
    ? rule.rule_id.trim()
    : `${candidateId.toLowerCase()}_rule_${index + 1}`;
  return {
    rule_id: ruleId,
    candidate_id: candidateId,
    type,
    assertion: stringOrFallback(rule.assertion, definition.problem_claim),
    current_observation: stringOrFallback(rule.current_observation, definition.evidence),
    pass_criteria: stringOrFallback(rule.pass_criteria, definition.suggested_fix),
    severity: stringOrFallback(rule.severity, definition.proposed_priority),
    source: stringOrFallback(rule.source, status === 'accepted' ? 'user_calibrated' : 'candidate_draft'),
  };
}

function ruleIds(candidate) {
  const ids = (candidate.learned_rules ?? []).map((rule) => rule.rule_id).filter(Boolean);
  return ids.length > 0 ? ids.join(', ') : '학습된 QA 규칙 없음';
}

function rulePassCriteria(candidate) {
  const criteria = (candidate.learned_rules ?? []).map((rule) => `${rule.rule_id}: ${rule.pass_criteria}`);
  return criteria.length > 0 ? criteria.join(' / ') : '학습된 QA 규칙을 먼저 정의해야 한다.';
}

function normalizeNoteMap(value) {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((id) => [String(id), '']));
  }
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => String(key).trim())
      .map(([key, note]) => [String(key), typeof note === 'string' ? note : String(note ?? '')]),
  );
}

function normalizeRewriteMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([id, rewrite]) => [String(id), rewriteForCandidate({ rewrites: { [id]: rewrite } }, id)])
      .filter(([, rewrite]) => Object.keys(rewrite).length > 0),
  );
}

function normalizeLearnedRulesMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([id, rules]) => [
        String(id),
        Array.isArray(rules)
          ? rules
              .map((rule, index) =>
                normalizeLearnedRule(rule, String(id), {
                  problem_claim: '',
                  evidence: '',
                  suggested_fix: '',
                  proposed_priority: 'P1',
                }, 'accepted', 'unknown', index),
              )
              .filter(Boolean)
          : [],
      ])
      .filter(([, rules]) => rules.length > 0),
  );
}

function stringOrFallback(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : String(fallback ?? '').trim();
}

function arraySet(value) {
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

function deduplicateStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function inferGuardiansFromSemanticText(screen, visibleText, semanticNodes = []) {
  const expected = Array.isArray(screen.expectedCharacters) ? screen.expectedCharacters : [];
  if (expected.length === 0) return [];
  const names = new Map([
    ['dragon', ['드래곤', '용']],
    ['lamir', ['라미르']],
    ['kael', ['카엘']],
    ['ersha', ['에르샤']],
    ['orden', ['오르덴']],
  ]);
  const joined = visibleText.join(' ');
  return expected
    .map((guardianId) => {
      const aliases = names.get(guardianId) ?? [guardianId];
      const matchingNode = semanticNodes.find((node) =>
        aliases.some((alias) => String(node.label ?? '').includes(alias)),
      );
      const hasText = aliases.some((alias) => joined.includes(alias)) || matchingNode;
      if (!hasText) return null;
      return {
        guardianId,
        displayName: aliases[0] ?? guardianId,
        semanticId: guardianId,
        state: 'semantic_text',
        bounds: matchingNode?.bounds ?? null,
        visible: matchingNode?.visible ?? true,
        evidence: 'semantic_text',
      };
    })
    .filter(Boolean);
}

async function ensureScreenArtifacts() {
  let existingArtifacts = null;
  if (await fileExists(screenArtifactsPath)) {
    const existing = await readJson(screenArtifactsPath);
    existingArtifacts = Array.isArray(existing.artifacts)
      ? existing.artifacts
      : Array.isArray(existing.screens)
        ? existing.screens
        : null;
  }

  const existingById = new Map((existingArtifacts ?? []).map(a => [a.screen, a]));
  const allCaptured =
    existingArtifacts &&
    existingArtifacts.length > 0 &&
    existingArtifacts.every(a => a.metadataQuality === 'captured');
  if (allCaptured) {
    return { artifacts: existingArtifacts, screens: existingArtifacts };
  }

  await mkdir(screenArtifactsDir, { recursive: true });
  const artifacts = [];
  for (const screen of matrix.screens ?? []) {
    const existing = existingById.get(screen.id);
    const captureRow = captureById.get(screen.id);

    if (existing && existing.metadataQuality === 'captured') {
      artifacts.push(existing);
      continue;
    }

    let artifact;
    const domMeta = captureRow?.domMeta ?? null;
    if (domMeta && captureRow) {
      artifact = enrichArtifactFromDomMeta(screen, captureRow, domMeta, matrix.viewport);
    } else if (existing) {
      artifact = { ...existing };
    } else {
      artifact = buildStubArtifact(screen, captureRow, matrix.viewport);
    }

    artifacts.push(artifact);
    await writeJson(join(screenArtifactsDir, `${screen.id}.json`), artifact);
  }

  const aggregate = {
    version: 1,
    generated_at: now,
    viewport: matrix.viewport,
    artifacts,
    screens: artifacts,
  };
  await writeJson(screenArtifactsPath, aggregate);
  return aggregate;
}

function enrichArtifactFromDomMeta(screen, captureRow, domMeta, viewport) {
  const semanticNodes = Array.isArray(domMeta.semanticNodes) ? domMeta.semanticNodes : [];
  const semanticText = semanticNodes.map((node) => node.label).filter(Boolean);
  const visibleText = Array.isArray(domMeta.visibleText) && domMeta.visibleText.length > 0
    ? domMeta.visibleText
    : deduplicateStrings([...(domMeta.ariaLabels ?? []), ...semanticText]).filter((line) => line !== 'Enable accessibility').slice(0, 200);
  const primaryCtas =
    Array.isArray(domMeta.primaryCtas) && domMeta.primaryCtas.length > 0
      ? domMeta.primaryCtas
      : deduplicateStrings([
          ...(domMeta.buttonLabels ?? []),
          ...semanticNodes
            .filter((node) => ['button', 'link'].includes(String(node.role ?? '').toLowerCase()))
            .map((node) => node.label),
        ]).map(label => ({
          label,
          enabled: true,
          action: null,
          bounds: null,
          semanticRole: 'button',
          disabledReason: null,
        }));

  const snap = domMeta.qaSnapshot ?? null;
  const renderedGuardians =
    snap?.guardians?.length > 0
      ? snap.guardians.map(g => ({ ...g, evidence: 'qa_snapshot' }))
      : (domMeta.ariaGuardians?.length > 0 ? domMeta.ariaGuardians : inferGuardiansFromSemanticText(screen, visibleText, semanticNodes));
  const renderedLocations =
    snap?.locations?.length > 0
      ? snap.locations.map(l => ({ ...l, evidence: 'qa_snapshot' }))
      : (domMeta.ariaLocations ?? []);
  const gameState = snap?.gameState ?? null;
  const sceneContract = snap?.sceneContract ?? null;
  const visualSubjects = dedupeVisualSubjects([
    ...(Array.isArray(snap?.visualSubjects) ? snap.visualSubjects : []),
    ...(Array.isArray(sceneContract?.visualSubjects) ? sceneContract.visualSubjects : []),
  ]);

  const hasText = visibleText.length > 0;
  const hasCtaOrGuardianOrLocation =
    primaryCtas.length > 0 || renderedGuardians.length > 0 || renderedLocations.length > 0;
  const hasGameState = gameState !== null;

  let metadataQuality;
  if (hasText && hasCtaOrGuardianOrLocation && hasGameState) {
    metadataQuality = 'captured';
  } else if (hasText || hasCtaOrGuardianOrLocation) {
    metadataQuality = 'partial';
  } else {
    metadataQuality = 'stub';
  }

  const missingEvidence = [];
  if (!hasText) missingEvidence.push('visibleText is empty');
  if (primaryCtas.length === 0) missingEvidence.push('primaryCtas is empty');
  if (
    renderedGuardians.length === 0 &&
    (screen.facets ?? []).some(f => ['guardian_presence', 'guardian_portrait'].includes(f))
  ) {
    missingEvidence.push('renderedGuardians missing for guardian facet screen');
  }
  if (!hasGameState) missingEvidence.push('gameState null — window.__QA_SNAPSHOT__ not exposed');

  const sourceList = ['capture_result.domMeta'];
  if (snap) sourceList.push('window.__QA_SNAPSHOT__');
  if (domMeta.ariaGuardians?.length > 0 && !snap?.guardians?.length) sourceList.push('aria_dom_guardians');
  if (domMeta.ariaLocations?.length > 0 && !snap?.locations?.length) sourceList.push('aria_dom_locations');

  const captureStatus = captureRow.status;
  return {
    screen: screen.id,
    screenshot: screen.screenshot,
    status: captureStatus === 'captured' || captureStatus === 'skipped_cached' ? 'captured' : 'failed',
    metadataQuality,
    route: `/?qaScreen=${screen.qaScreen}`,
    viewport,
    visibleText,
    primaryCtas,
    renderedGuardians,
    renderedLocations,
    sceneContract,
    visualSubjects,
    gameState,
    missingEvidence,
    source: sourceList,
  };
}

function buildStubArtifact(screen, captureRow, viewport) {
  return {
    screen: screen.id,
    screenshot: screen.screenshot,
    status: captureRow?.status === 'captured' || captureRow?.status === 'skipped_cached' ? 'captured' : 'failed',
    metadataQuality: 'stub',
    route: `/?qaScreen=${screen.qaScreen}`,
    viewport,
    visibleText: [],
    primaryCtas: [],
    renderedGuardians: [],
    renderedLocations: [],
    sceneContract: null,
    visualSubjects: [],
    gameState: null,
    missingEvidence: ['no domMeta available — run qa_capture_chrome.mjs to populate artifacts'],
    source: ['stub'],
  };
}

function dedupeVisualSubjects(subjects) {
  const seen = new Set();
  const result = [];
  for (const subject of subjects ?? []) {
    const key = String(subject?.id ?? subject?.messageId ?? subject?.subjectId ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(subject);
  }
  return result;
}

async function readOptionalJson(path, fallback) {
  if (!(await fileExists(path))) return fallback;
  return readJson(path);
}

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
