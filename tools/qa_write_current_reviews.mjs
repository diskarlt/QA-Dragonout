#!/usr/bin/env node

import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileExists, readJson, scoreKeys } from './qa_lib.mjs';

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
    '현재 390x844 캡처를 고정 QA 룰로 평가하고, 룰 finding만 개발 큐 FAIL로 승격한다.',
  viewport: matrix.viewport,
  status:
    productScreens.some((screen) => screen.status === 'fail') || fixedGlobalRules.length > 0
      ? 'fail'
      : 'calibration_pending',
  calibration_round: calibrationRound,
  fixed_rules_source: fixedRulesPath,
  global_visual_findings: fixedGlobalRules.map((rule) => findingFromRule(rule, globalTargetLabel(rule.target_id))),
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
    '플레이 경험을 고정 QA 룰로 평가하고, 룰 finding만 개발 큐 FAIL로 승격한다.',
  status: flowReviews.some((flow) => flow.verdict === 'fail') ? 'fail' : 'calibration_pending',
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
  const status = rules.length > 0 ? 'fixed_rule_fail' : (candidate?.calibration_status ?? 'not_started');
  const ruleFailed = rules.length > 0;
  const lint = lintById.get(screen.id);
  const captureRow = captureById.get(screen.id);
  const reviewedOriginal =
    screen.mustReviewAtOriginalSize === true || firstRoundScreenIds.includes(screen.id);
  return {
    id: screen.id,
    screen: screen.screen,
    state: screen.state,
    screenshot: `screenshots/${screen.screenshot}`,
    status: ruleFailed ? 'fail' : 'low_confidence',
    ship_readiness: ruleFailed ? 'needs_polish' : shipReadinessForCalibration(status),
    reviewed_original: reviewedOriginal,
    scores: Object.fromEntries(qualityAxes.map((key) => [key, ruleFailed ? 3 : 4])),
    requiredEvidence: screen.requiredEvidence,
    review_note: productReviewNote(screen, candidate, status, rules),
    fixed_rules: rules,
    findings: rules.map((rule) => findingFromRule(rule, screen.screenshot)),
    rationale: productRationale(screen, candidate, status, captureRow, rules),
    recommended_fix: productRecommendedFix(screen, candidate, status, rules),
    contract_results: productContractResults(screen, candidate, status, lint),
  };
}

function playthroughFlowReview(flow) {
  const candidate = candidateByFlowId.get(flow.id);
  const rules = fixedFlowRulesById.get(flow.id) ?? [];
  const status = rules.length > 0 ? 'fixed_rule_fail' : (candidate?.calibration_status ?? 'not_started');
  const ruleFailed = rules.length > 0;
  const scoreKeysForFlow = playthroughMatrix.requiredScoreKeys ?? [
    'dialogue_flow',
    'choice_consequence',
    'ending_payoff',
  ];
  return {
    flow_id: flow.id,
    title: flow.title,
    steps: flow.steps,
    screenshots: (flow.steps ?? []).map((id) => screenshotForStep(id)),
    verdict: ruleFailed ? 'fail' : 'low_confidence',
    calibration_status: status,
    scenario_scores: Object.fromEntries(scoreKeysForFlow.map((key) => [key, ruleFailed ? 3 : 4])),
    expectedFlow: flowContractRows(flow.acceptanceCriteria, flow, candidate, status, 'expected_flow'),
    observedFlow: flowContractRows(flow.requiredEvidence, flow, candidate, status, 'observed_flow'),
    forbiddenFlowBreaks: [
      {
        id: 'calibration_not_confirmed',
        label: '고정 QA 룰 finding 없이 플레이 경험 후보를 개발 큐로 확정하지 않는다.',
        status: ruleFailed ? 'present' : 'not_observed',
        note: ruleFailed
          ? `${flow.title}은 고정 QA 룰 ${ruleIdsFromRules(rules)} finding으로 개발 큐에 승격됐다.`
          : `${flow.title}은 ${statusLabel(status)} 상태라 플레이 경험 수정 후보로만 표시한다.`,
      },
    ],
    transcript: flowTranscript(flow, candidate, status),
    requiredEvidence: flow.requiredEvidence,
    review_note: flowReviewNote(flow, candidate, status, rules),
    fixed_rules: rules,
    findings: rules.map((rule) => findingFromRule(rule, flow.title)),
    recommended_fix: flowRecommendedFix(flow, candidate, status, rules),
  };
}

function productReviewNote(screen, candidate, status, rules) {
  if (rules.length > 0) {
    return `${screen.screenshot}은 고정 QA 룰 ${ruleIdsFromRules(rules)} 위반으로 개발 큐에 들어갔다.`;
  }
  if (!candidate) {
    return `${screen.screenshot}은 첫 캘리브레이션 라운드 대상이 아니므로 개발 큐에 올리지 않고 다음 라운드 대기 상태로 둔다.`;
  }
  return `${screen.screenshot} 후보 ${candidate.candidate_id}는 ${statusLabel(status)} 상태다: ${candidate.problem_claim}`;
}

function productRationale(screen, candidate, status, captureRow, rules) {
  if (rules.length > 0) {
    return `${screen.screenshot} 캡처 상태 ${captureRow?.status ?? '미확인'}이며, 고정 QA 룰 finding 근거는 ${rules.map((rule) => `${rule.rule_id}: ${rule.observed_evidence}`).join(' / ')}`;
  }
  if (!candidate) {
    return `${screen.screenshot} 캡처 상태 ${captureRow?.status ?? '미확인'}이며, 사용자 기준을 받기 전에는 화면 문제를 확정하지 않는다.`;
  }
  return `${screen.screenshot} 캡처 상태 ${captureRow?.status ?? '미확인'}이며, 후보 관찰 근거는 ${candidate.evidence}`;
}

function productRecommendedFix(screen, candidate, status, rules) {
  if (rules.length > 0) {
    return `${screen.screenshot} 개발 큐: ${rules.map((rule) => `${rule.rule_id} 수정: ${rule.recommended_fix} 통과 기준: ${rule.pass_criteria}`).join(' / ')}`;
  }
  if (!candidate) {
    return `${screen.screenshot} 다음 캘리브레이션 라운드에서 후보로 올릴지 결정한다.`;
  }
  return `${screen.screenshot} 고정 QA 룰 미정: 허들 설정 화면에서 룰로 승격할지 먼저 결정한다.`;
}

function flowReviewNote(flow, candidate, status, rules) {
  if (rules.length > 0) {
    return `${flow.title}은 고정 QA 룰 ${ruleIdsFromRules(rules)} 위반으로 플레이 경험 개발 큐에 들어갔다.`;
  }
  if (!candidate) {
    return `${flow.title}은 첫 캘리브레이션 라운드 대상이 아니므로 플레이 경험 개발 큐에 올리지 않는다.`;
  }
  return `${flow.title} 후보 ${candidate.candidate_id}는 ${statusLabel(status)} 상태다: ${candidate.problem_claim}`;
}

function flowRecommendedFix(flow, candidate, status, rules) {
  if (rules.length > 0) {
    return `${flow.title} 개발 큐: ${rules.map((rule) => `${rule.rule_id} 수정: ${rule.recommended_fix} 통과 기준: ${rule.pass_criteria}`).join(' / ')}`;
  }
  if (!candidate) {
    return `${flow.title} 다음 캘리브레이션 라운드에서 후보로 올릴지 결정한다.`;
  }
  return `${flow.title} 고정 QA 룰 미정: 허들 설정 화면에서 룰로 승격할지 먼저 결정한다.`;
}

function productContractResults(screen, candidate, status, lint) {
  const ruleFailed = status === 'fixed_rule_fail';
  const notePrefix = candidate
    ? `후보 ${candidate.candidate_id} ${statusLabel(status)}`
    : '첫 라운드 대상 아님';
  return {
    expected: (screen.expected ?? []).map((item) => ({
      id: item.id,
      label: item.label,
      status: ruleFailed ? 'fail' : 'not_observed',
      note: ruleFailed
        ? `${screen.screenshot}에서 ${item.label} 기준은 고정 QA 룰 finding 때문에 개발 큐로 승격됐다.`
        : `${screen.screenshot}의 ${item.label} 기준은 ${notePrefix} 상태라 확정 FAIL로 쓰지 않는다.`,
    })),
    implementedEvidence: (screen.implementedEvidence ?? []).map((item) => ({
      id: item.id,
      label: item.label,
      status: ruleFailed ? 'fail' : 'not_observed',
      note: ruleFailed
        ? `${screen.screenshot}의 자동 lint 상태(${lint?.status ?? 'missing'})와 고정 QA 룰 근거를 함께 보고 개발 대상으로 확정했다.`
        : `${screen.screenshot}의 자동 lint 상태(${lint?.status ?? 'missing'})는 참고만 하며, ${notePrefix} 전에는 개발 큐로 확정하지 않는다.`,
    })),
    forbidden: (screen.forbidden ?? []).map((item) => ({
      id: item.id,
      label: item.label,
      status: ruleFailed ? 'present' : 'absent',
      note: ruleFailed
        ? `${screen.screenshot}에서 ${item.label} 위험을 고정 QA 룰 finding의 개발 근거로 기록했다.`
        : `${screen.screenshot}의 ${item.label} 위험은 ${notePrefix} 상태라 확정 finding으로 쓰지 않는다.`,
    })),
  };
}

function flowContractRows(labels = [], flow, candidate, status, prefix) {
  const ruleFailed = status === 'fixed_rule_fail';
  return labels.map((label, index) => ({
    id: `${prefix}_${index + 1}`,
    label,
    status: ruleFailed ? 'fail' : 'not_observed',
    note: ruleFailed
      ? `${flow.title}의 ${label} 기준은 고정 QA 룰 finding 때문에 개발 큐로 승격됐다.`
      : `${flow.title}의 ${label} 기준은 ${candidate ? `후보 ${candidate.candidate_id}` : '첫 라운드 대상 아님'} ${statusLabel(status)} 상태라 확정 FAIL로 쓰지 않는다.`,
  }));
}

function flowTranscript(flow, candidate, status) {
  if (!candidate) {
    return (flow.steps ?? []).map((step, index) => `${index + 1}. ${step} 흐름은 첫 라운드 캘리브레이션 대상이 아니다.`);
  }
  if (status === 'fixed_rule_fail') {
    const rules = fixedFlowRulesById.get(flow.id) ?? [];
    return [
      `${flow.title}은 고정 QA 룰 ${ruleIdsFromRules(rules)} 위반으로 재검출됐다.`,
      `${candidate.candidate_id} 후보 관찰 근거: ${candidate.evidence}`,
      `통과 기준: ${rules.map((rule) => `${rule.rule_id}=${rule.pass_criteria}`).join(' / ')}`,
    ];
  }
  return [
    `${candidate.candidate_id} ${flow.title}: ${candidate.evidence}`,
    `현재 상태: ${statusLabel(status)}`,
    '고정 QA 룰 finding이 없으므로 normal report의 개발 큐에는 올리지 않는다.',
  ];
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

async function readOptionalJson(path, fallback) {
  if (!(await fileExists(path))) return fallback;
  return readJson(path);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
