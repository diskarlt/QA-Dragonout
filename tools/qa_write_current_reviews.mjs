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
const qualityAxes = matrix.qualityStandard?.scoreKeys ?? scoreKeys();
const now = new Date().toISOString();
const screenArtifacts = await ensureScreenArtifacts();
const artifactById = new Map((screenArtifacts.screens ?? []).map((artifact) => [artifact.screen, artifact]));

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
const productReview = {
  generated_at: now,
  reviewed_by: 'Codex',
  review_method:
    '현재 390x844 캡처를 QA Matrix 화면군 기준과 repo-tracked 고정 QA 룰로 평가해 개발 큐 후보를 만든다.',
  viewport: matrix.viewport,
  status:
    productScreens.some((screen) => screen.status === 'fail') || fixedGlobalRules.length > 0
      ? 'fail'
      : productScreens.some((screen) => screen.status === 'blocked')
        ? 'blocked'
        : productScreens.some((screen) => screen.status === 'rule_invalid')
          ? 'rule_invalid'
          : 'pass',
  calibration_round: calibrationRound,
  fixed_rules_source: fixedRulesPath,
  global_visual_findings: fixedGlobalRules.map((rule) => findingFromRule(rule, globalTargetLabel(rule.target_id))),
  qa_issues: fixedGlobalRules.map((rule) => issueFromFixedRule(rule, {
    source: 'product_review',
    targetType: 'global',
    targetId: rule.target_id,
    sourcePointer: `codex_product_review.json:global:${rule.rule_id}`,
  })),
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
  const fixedRuleIssues = rules.map((rule) => issueFromFixedRule(rule, {
    source: 'product_review',
    targetType: 'screen',
    targetId: screen.id,
    screenshot: screen.screenshot,
    sourcePointer: `codex_product_review.json:screens:${screen.id}:${rule.rule_id}`,
  }));
  const qaIssues = captured
    ? normalizeIssues([
        ...fixedRuleIssues,
        ...matrixIssuesForScreen(screen, lint, artifactById.get(screen.id)),
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
      .filter((rule) => !requiresMotionEvidence(rule))
      .map((rule) => findingFromRule(rule, screen.screenshot)),
    rationale: productRationale(screen, status, captureRow, qaIssues),
    recommended_fix: productRecommendedFix(screen, status, qaIssues),
    contract_results: productContractResults(screen, status, lint, qaIssues),
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
  const qaIssues = rules.length > 0
    ? rules.map((rule) => issueFromFixedRule(rule, {
        source: 'playthrough_review',
        targetType: 'flow',
        targetId: flow.id,
        sourcePointer: `codex_playthrough_review.json:flows:${flow.id}:${rule.rule_id}`,
      }))
    : [blockedIssue({
        id: `${flow.id}.qa_evidence_incomplete`,
        source: 'playthrough_review',
        targetType: 'flow',
        targetId: flow.id,
        observed: `${flow.title} 흐름은 실제 한국어 transcript와 CTA/선택/결과 연결 기록이 부족해 PASS/FAIL을 판정할 수 없다.`,
        expected: `${flow.title} 흐름은 실제 화면 문구, 사용자 행동, CTA/선택/결과 연결을 기준으로 PASS 또는 FAIL을 판정해야 한다.`,
        missingEvidence: [
          '실제 화면 문구가 포함된 한국어 transcript',
          'CTA/선택/결과 연결 근거',
          '사용자 행동 순서 기록',
        ],
        blockedReason: `${flow.title} 흐름의 문제를 개발 티켓으로 확정할 직접 흐름 증거가 부족하다.`,
        sourcePointer: `codex_playthrough_review.json:flows:${flow.id}:qa_evidence_incomplete`,
      })];
  const failIssues = qaIssues.filter((issue) => issue.status === 'FAIL');
  const blockedIssues = qaIssues.filter((issue) => issue.status === 'BLOCKED');
  const invalidIssues = qaIssues.filter((issue) => issue.status === 'RULE_INVALID');
  return {
    flow_id: flow.id,
    title: flow.title,
    steps: flow.steps,
    screenshots: (flow.steps ?? []).map((id) => screenshotForStep(id)),
    verdict: failIssues.length > 0
      ? 'fail'
      : blockedIssues.length > 0
        ? 'blocked'
        : invalidIssues.length > 0
          ? 'rule_invalid'
          : 'pass',
    calibration_status: failIssues.length > 0 ? 'fixed_rule_fail' : 'qa_evidence_required',
    scenario_scores: Object.fromEntries(scoreKeysForFlow.map((key) => [key, failIssues.length > 0 ? 3 : 4])),
    expectedFlow: flowContractRows(flow.acceptanceCriteria, flow, failIssues.length > 0, 'expected_flow'),
    observedFlow: flowContractRows(flow.requiredEvidence, flow, failIssues.length > 0, 'observed_flow'),
    forbiddenFlowBreaks: [
      {
        id: failIssues.length > 0 ? 'fixed_rule_flow_fail' : 'flow_evidence_incomplete',
        label: failIssues.length > 0
          ? '고정 QA 룰 finding으로 흐름 결함이 검출됐다.'
          : '실제 transcript 없이 흐름 문제를 확정하지 않는다.',
        status: failIssues.length > 0 ? 'present' : 'not_observed',
        note: failIssues.length > 0
          ? `${flow.title}은 고정 QA 룰 ${ruleIdsFromRules(rules)} finding으로 개발 큐에 승격됐다.`
          : `${flow.title}은 실제 한국어 transcript와 행동 연결 증거를 보강해야 한다.`,
      },
    ],
    transcript: flowTranscript(flow, failIssues.length > 0),
    requiredEvidence: flow.requiredEvidence,
    review_note: flowReviewNote(flow, qaIssues),
    qa_issues: qaIssues,
    fixed_rules: rules,
    findings: rules.map((rule) => findingFromRule(rule, flow.title)),
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
  return `${flow.title}은 실제 한국어 transcript와 행동 연결 증거가 부족해 QA 보강 필요로 남긴다.`;
}

function flowRecommendedFix(flow, qaIssues) {
  const failIssues = qaIssues.filter((issue) => issue.status === 'FAIL');
  if (failIssues.length > 0) {
    return `${flow.title} 개발 큐 후보 ${failIssues.length}건: ${failIssues.map((issue) => issue.id).join(', ')}`;
  }
  return `${flow.title} 실제 한국어 transcript와 CTA/선택/결과 연결 근거를 보강한 뒤 PASS 또는 FAIL로 재분류한다.`;
}

function productContractResults(screen, status, lint, qaIssues) {
  const issueByCriterion = new Map();
  for (const issue of qaIssues) {
    const criterionId = issue.rule_id ?? issue.id.split('.').at(-1);
    issueByCriterion.set(criterionId, issue);
  }
  return {
    expected: (screen.expected ?? []).map((item) => ({
      id: item.id,
      label: item.label,
      status: contractStatusFromIssue(issueByCriterion.get(item.id), 'expected'),
      note: contractNoteForItem(screen, item, status, issueByCriterion.get(item.id), lint),
    })),
    implementedEvidence: (screen.implementedEvidence ?? []).map((item) => ({
      id: item.id,
      label: item.label,
      status: contractStatusFromIssue(issueByCriterion.get(item.id), 'implementedEvidence'),
      note: contractNoteForItem(screen, item, status, issueByCriterion.get(item.id), lint),
    })),
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
  return labels.map((label, index) => ({
    id: `${prefix}_${index + 1}`,
    label,
    status: ruleFailed ? 'fail' : 'not_observed',
    note: ruleFailed
      ? `${flow.title}의 ${label} 기준은 고정 QA 룰 finding 때문에 개발 큐로 승격됐다.`
      : `${flow.title}의 ${label} 기준은 실제 한국어 transcript와 행동 연결 증거가 필요하다.`,
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
  return (flow.steps ?? []).map((step, index) => `${index + 1}. ${step} 화면의 실제 한국어 문구와 CTA 행동 기록이 없어 흐름 판정 보강이 필요하다.`);
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
    rule_id: item.id,
    regression_lock: firstRoundScreenIds.includes(screen.id),
    source_pointer: `codex_product_review.json:screens:${screen.id}:${item.id}`,
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
    return {
      status: 'BLOCKED',
      observed: `${screen.screenshot}은 정지 screenshot artifact만 있어 "${item.label}" motion 룰을 PASS 또는 FAIL로 판정할 수 없다.`,
      blockedReason: 'motion/Live2D 룰은 정지 screenshot이 아니라 2초 비디오 또는 3개 timestamp frame evidence가 필요하다.',
      missingEvidence: ['video_2s_or_3_timestamp_frames'],
      requiredArtifact: ['video_2s_or_3_timestamp_frames'],
    };
  }
  if (requiresGuardianMetadata(screen, item) && !hasUsableGuardianArtifact(artifact)) {
    return {
      status: 'BLOCKED',
      observed: `${screen.screenshot}의 "${item.label}" 기준은 renderedGuardians metadata가 없어 PASS 또는 FAIL로 판정할 수 없다.`,
      blockedReason: 'guardian 관련 룰은 expectedCharacters와 실제 renderedGuardians metadata 비교가 필요하다.',
      missingEvidence: ['renderedGuardians metadata', 'expectedCharacters metadata', `screen_artifacts/${screen.id}.json`],
      requiredArtifact: ['screen_artifacts.json', `screen_artifacts/${screen.id}.json`],
    };
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
    'static_portrait_no_live2d',
    'static_portrait_no_motion_evidence',
    'guardian_motion.pseudo_live2d_presence',
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
  return Boolean(
    artifact &&
      Array.isArray(artifact.renderedGuardians) &&
      artifact.renderedGuardians.length > 0 &&
      artifact.metadataQuality !== 'stub',
  );
}

function requiresMotionEvidence(rule) {
  return (rule.requires_evidence ?? []).includes('video_2s_or_3_timestamp_frames') ||
    ['guardian_live2d_layered_motion', 'guardian_motion.pseudo_live2d_presence'].includes(rule.rule_id);
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

async function ensureScreenArtifacts() {
  if (await fileExists(screenArtifactsPath)) {
    const existing = await readJson(screenArtifactsPath);
    if (Array.isArray(existing.screens)) {
      return existing;
    }
  }
  await mkdir(screenArtifactsDir, { recursive: true });
  const screens = [];
  for (const screen of matrix.screens ?? []) {
    const captureRow = captureById.get(screen.id);
    const artifact = {
      screen: screen.id,
      screenshot: screen.screenshot,
      viewport: matrix.viewport,
      route: `/?qaScreen=${screen.qaScreen}`,
      visibleText: [],
      primaryCtas: [],
      renderedGuardians: [],
      renderedLocations: [],
      gameState: {
        qaScreen: screen.qaScreen,
        state: screen.state,
        expectedCharacters: screen.expectedCharacters ?? [],
        captureStatus: captureRow?.status ?? 'missing',
      },
      metadataQuality: 'stub',
      requiredEvidenceTypes: [],
    };
    screens.push(artifact);
    await writeJson(join(screenArtifactsDir, `${screen.id}.json`), artifact);
  }
  const aggregate = {
    generated_at: now,
    source: 'qa_write_current_reviews fallback metadata',
    report_dir: reportDir,
    screens,
  };
  await writeJson(screenArtifactsPath, aggregate);
  return aggregate;
}

async function readOptionalJson(path, fallback) {
  if (!(await fileExists(path))) return fallback;
  return readJson(path);
}

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
