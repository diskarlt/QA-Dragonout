export const QA_ISSUE_STATUSES = ['FAIL', 'BLOCKED', 'RULE_INVALID', 'PASS', 'SKIP'];
export const DEV_QUEUE_STATUSES = ['FAIL'];
export const QA_QUEUE_STATUSES = ['BLOCKED', 'RULE_INVALID', 'SKIP'];
export const REGRESSION_LOCK_SCREEN_IDS = [
  'start',
  'base_status',
  'guardian_dialog',
  'location_dialog',
  'outing',
];
export const REQUIRED_BASE_STATUS_RULE_IDS = [
  'guardian_presence_exact',
  'guardian_portrait_scale_consistency',
  'guardian_portrait_no_crop',
  'guardian_motion.pseudo_live2d_presence',
  'cta_ssot_contract',
];

export function severityRank(severity) {
  return { P0: 4, P1: 3, P2: 2, P3: 1 }[String(severity ?? '').toUpperCase()] ?? 0;
}

export function normalizeStatus(status) {
  const normalized = String(status ?? '').trim().toUpperCase();
  if (normalized === 'LOW' || normalized === 'LOW_CONFIDENCE') return 'BLOCKED';
  if (normalized === 'BLOCKED') return 'BLOCKED';
  if (normalized === 'RULE_INVALID' || normalized === 'INVALID') return 'RULE_INVALID';
  if (normalized === 'PASS') return 'PASS';
  if (normalized === 'SKIP' || normalized === 'SKIPPED') return 'SKIP';
  return 'FAIL';
}

export function targetTypeForRule(rule) {
  if (rule.type === 'play_experience') return 'flow';
  if (rule.type === 'global_visual') return 'global';
  return 'screen';
}

export function categoryForRule(rule) {
  if (rule.category) return String(rule.category);
  if (rule.type === 'play_experience') return 'playthrough_flow';
  if (rule.type === 'global_visual') return 'visual_regression';
  if (String(rule.rule_id ?? '').includes('cta')) return 'contract_regression';
  if (String(rule.rule_id ?? '').includes('motion') || String(rule.rule_id ?? '').includes('live2d')) return 'motion_evidence';
  if (String(rule.rule_id ?? '').includes('portrait')) return 'visual_regression';
  return 'product_contract';
}

export function issueFromFixedRule(rule, options = {}) {
  const targetId = options.targetId ?? rule.target_id;
  const targetType = options.targetType ?? targetTypeForRule(rule);
  const screenshot = options.screenshot ?? null;
  const observed = String(rule.observed_evidence ?? '').trim();
  const passCondition = String(rule.pass_criteria ?? '').trim();
  const recommendedFix = String(rule.recommended_fix ?? '').trim();
  const requiredEvidence = normalizeStringList(rule.requires_evidence);
  if (requiredEvidence.includes('video_2s_or_3_timestamp_frames') && options.motionEvidenceAvailable !== true) {
    return blockedIssue({
      id: `${targetId}.${rule.rule_id}`,
      source: options.source ?? (targetType === 'flow' ? 'playthrough_review' : 'product_review'),
      targetType,
      targetId,
      screenshot,
      severity: rule.severity ?? 'P1',
      category: categoryForRule(rule),
      observed: `${targetId}의 ${rule.rule_id} 룰은 screenshot artifact만으로 motion/Live2D 상태를 PASS 또는 FAIL로 판정할 수 없다.`,
      expected: rule.assertion ?? passCondition,
      missingEvidence: requiredEvidence,
      requiredArtifact: requiredEvidence,
      blockedReason: 'motion 룰은 2초 비디오 또는 3개 timestamp frame artifact가 필요하다.',
      passCondition,
      recommendedFix: 'motion evidence artifact를 캡처한 뒤 동일 룰을 PASS 또는 FAIL로 재분류한다.',
      regressionLock: REGRESSION_LOCK_SCREEN_IDS.includes(targetId),
      ruleId: rule.rule_id,
      sourcePointer: options.sourcePointer,
      evidencePointer: options.evidencePointer ?? options.sourcePointer,
    });
  }
  return normalizeQaIssue({
    id: `${targetId}.${rule.rule_id}`,
    source: options.source ?? (targetType === 'flow' ? 'playthrough_review' : 'product_review'),
    target_type: targetType,
    target_id: targetId,
    status: 'FAIL',
    severity: rule.severity ?? 'P1',
    category: categoryForRule(rule),
    rule_id: rule.rule_id,
    evidence: {
      screenshot,
      observed,
    },
    expected: rule.assertion ?? passCondition,
    recommended_fix: recommendedFix,
    pass_condition: passCondition,
    regression_lock: REGRESSION_LOCK_SCREEN_IDS.includes(targetId),
    source_pointer: options.sourcePointer,
    evidence_pointer: options.evidencePointer ?? options.sourcePointer,
  });
}

export function blockedIssue(options = {}) {
  const targetId = options.targetId ?? 'unknown';
  const targetType = options.targetType ?? 'screen';
  return normalizeQaIssue({
    id: options.id ?? `${targetId}.qa_evidence_incomplete`,
    source: options.source ?? (targetType === 'flow' ? 'playthrough_review' : 'product_review'),
    target_type: targetType,
    target_id: targetId,
    status: 'BLOCKED',
    severity: options.severity ?? 'P3',
    category: options.category ?? 'qa_evidence',
    rule_id: options.ruleId,
    evidence: {
      screenshot: options.screenshot ?? null,
      observed: options.observed ?? `${targetId} 기준을 PASS/FAIL로 단정할 직접 관찰 근거가 부족하다.`,
    },
    expected: options.expected ?? `${targetId} 기준을 판단할 현재 캡처 또는 실제 흐름 증거가 필요하다.`,
    missing_evidence: options.missingEvidence ?? ['원본 크기 캡처 근거', '한국어 review note', '고정 QA 룰 finding 여부'],
    required_artifact: options.requiredArtifact ?? options.missingEvidence ?? ['원본 크기 캡처 근거'],
    blocked_reason: options.blockedReason ?? '현재 QA 산출물만으로 문제 여부를 단정할 수 없어 PASS 선언을 막는다.',
    pass_condition: options.passCondition ?? '필요 증거를 추가한 뒤 동일 기준이 PASS 또는 FAIL로 재분류되어야 한다.',
    recommended_fix: options.recommendedFix ?? 'QA 증거를 보강한 뒤 개발 큐 승격 여부를 다시 판단한다.',
    regression_lock: options.regressionLock ?? REGRESSION_LOCK_SCREEN_IDS.includes(targetId),
    source_pointer: options.sourcePointer,
    evidence_pointer: options.evidencePointer ?? options.sourcePointer,
  });
}

export function lowConfidenceIssue(options = {}) {
  return blockedIssue(options);
}

export function ruleInvalidIssue(options = {}) {
  const targetId = options.targetId ?? 'unknown';
  const targetType = options.targetType ?? 'screen';
  return normalizeQaIssue({
    id: options.id ?? `${targetId}.rule_invalid`,
    source: options.source ?? (targetType === 'flow' ? 'playthrough_review' : 'product_review'),
    target_type: targetType,
    target_id: targetId,
    status: 'RULE_INVALID',
    severity: options.severity ?? 'P3',
    category: options.category ?? 'rule_contract',
    rule_id: options.ruleId,
    evidence: {
      screenshot: options.screenshot ?? null,
      observed: options.observed ?? `${targetId} 기준은 현재 룰 문장만으로 PASS/FAIL 판정이 불가능하다.`,
    },
    expected: options.expected ?? `${targetId} 기준은 passIf/failIf/blockedIf를 가진 판정형 룰이어야 한다.`,
    invalid_reason: options.invalidReason ?? 'passIf/failIf가 없거나 감상형 문구만 있어 판정 기준으로 사용할 수 없다.',
    rewritten_rule_suggestion: options.rewrittenRuleSuggestion ?? '관찰 가능한 passIf, failIf, blockedIf를 추가한다.',
    pass_condition: options.passCondition ?? '룰을 판정형 조건으로 재작성한 뒤 QA를 다시 생성한다.',
    recommended_fix: options.recommendedFix ?? 'QA 룰을 구체 조건으로 재작성한다.',
    regression_lock: options.regressionLock ?? REGRESSION_LOCK_SCREEN_IDS.includes(targetId),
    source_pointer: options.sourcePointer,
    evidence_pointer: options.evidencePointer ?? options.sourcePointer,
  });
}

export function skipIssue(options = {}) {
  const targetId = options.targetId ?? 'unknown';
  const targetType = options.targetType ?? 'screen';
  return normalizeQaIssue({
    id: options.id ?? `${targetId}.qa_skip`,
    source: options.source ?? (targetType === 'flow' ? 'playthrough_review' : 'product_review'),
    target_type: targetType,
    target_id: targetId,
    status: 'SKIP',
    severity: options.severity ?? 'P3',
    category: options.category ?? 'qa_scope',
    evidence: {
      screenshot: options.screenshot ?? null,
      observed: options.observed ?? `${targetId}는 현재 QA mode 또는 범위 밖이라 판정에서 제외됐다.`,
    },
    expected: options.expected ?? `${targetId}가 QA 대상일 때만 PASS/FAIL/BLOCKED/RULE_INVALID로 판정한다.`,
    pass_condition: options.passCondition ?? '해당 대상이 QA 범위에 포함되면 다시 판정한다.',
    recommended_fix: options.recommendedFix ?? '추가 개발 조치 없음.',
    regression_lock: false,
    source_pointer: options.sourcePointer,
    evidence_pointer: options.evidencePointer ?? options.sourcePointer,
  });
}

export function passIssue(options = {}) {
  const targetId = options.targetId ?? 'unknown';
  const targetType = options.targetType ?? 'screen';
  return normalizeQaIssue({
    id: options.id ?? `${targetId}.qa_contract_pass`,
    source: options.source ?? (targetType === 'flow' ? 'playthrough_review' : 'product_review'),
    target_type: targetType,
    target_id: targetId,
    status: 'PASS',
    severity: options.severity ?? 'P3',
    category: options.category ?? 'qa_contract',
    evidence: {
      screenshot: options.screenshot ?? null,
      observed: options.observed ?? options.passEvidence,
    },
    expected: options.expected ?? `${targetId} QA 기준을 충족한다.`,
    pass_evidence: options.passEvidence ?? options.observed,
    pass_condition: options.passCondition ?? `${targetId} 기준이 다음 QA에서도 같은 관찰 근거로 확인되어야 한다.`,
    concrete_observed_evidence: options.concreteObservedEvidence ?? options.passEvidence ?? options.observed,
    recommended_fix: options.recommendedFix ?? '추가 개발 조치 없음.',
    regression_lock: options.regressionLock ?? REGRESSION_LOCK_SCREEN_IDS.includes(targetId),
    source_pointer: options.sourcePointer,
    evidence_pointer: options.evidencePointer ?? options.sourcePointer,
  });
}

export function normalizeQaIssue(raw = {}, defaults = {}) {
  const status = normalizeStatus(raw.status ?? defaults.status);
  const evidence = raw.evidence && typeof raw.evidence === 'object' ? raw.evidence : {};
  return {
    id: String(raw.id ?? defaults.id ?? '').trim(),
    source: String(raw.source ?? defaults.source ?? '').trim(),
    target_type: String(raw.target_type ?? defaults.target_type ?? '').trim(),
    target_id: String(raw.target_id ?? defaults.target_id ?? '').trim(),
    status,
    severity: String(raw.severity ?? defaults.severity ?? (status === 'FAIL' ? 'P2' : 'P3')).trim(),
    category: String(raw.category ?? defaults.category ?? 'qa_issue').trim(),
    rule_id: raw.rule_id ? String(raw.rule_id).trim() : undefined,
    evidence: {
      screenshot: evidence.screenshot ?? raw.screenshot ?? defaults.screenshot ?? null,
      observed: String(evidence.observed ?? raw.observed ?? defaults.observed ?? '').trim(),
    },
    expected: String(raw.expected ?? defaults.expected ?? '').trim(),
    recommended_fix: String(raw.recommended_fix ?? defaults.recommended_fix ?? '').trim(),
    pass_condition: String(raw.pass_condition ?? defaults.pass_condition ?? '').trim(),
    pass_evidence: raw.pass_evidence ? String(raw.pass_evidence).trim() : undefined,
    concrete_observed_evidence: raw.concrete_observed_evidence ? String(raw.concrete_observed_evidence).trim() : undefined,
    missing_evidence: normalizeStringList(raw.missing_evidence ?? defaults.missing_evidence),
    required_artifact: normalizeStringList(raw.required_artifact ?? defaults.required_artifact),
    blocked_reason: raw.blocked_reason ? String(raw.blocked_reason).trim() : undefined,
    invalid_reason: raw.invalid_reason ? String(raw.invalid_reason).trim() : undefined,
    rewritten_rule_suggestion: raw.rewritten_rule_suggestion ? String(raw.rewritten_rule_suggestion).trim() : undefined,
    regression_lock: Boolean(raw.regression_lock ?? defaults.regression_lock),
    source_pointer: raw.source_pointer ?? defaults.source_pointer
      ? String(raw.source_pointer ?? defaults.source_pointer).trim()
      : undefined,
    evidence_pointer: raw.evidence_pointer ?? defaults.evidence_pointer ?? raw.source_pointer ?? defaults.source_pointer
      ? String(raw.evidence_pointer ?? defaults.evidence_pointer ?? raw.source_pointer ?? defaults.source_pointer).trim()
      : undefined,
  };
}

export function normalizeIssues(issues = []) {
  return dedupeIssues(issues.map((issue) => normalizeQaIssue(issue)));
}

export function dedupeIssues(issues = []) {
  const priority = { FAIL: 5, BLOCKED: 4, RULE_INVALID: 3, PASS: 2, SKIP: 1 };
  const byId = new Map();
  for (const issue of issues) {
    if (!issue.id) continue;
    const existing = byId.get(issue.id);
    if (
      !existing ||
      priority[issue.status] > priority[existing.status] ||
      (priority[issue.status] === priority[existing.status] &&
        severityRank(issue.severity) > severityRank(existing.severity))
    ) {
      byId.set(issue.id, issue);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const statusDelta = priority[b.status] - priority[a.status];
    if (statusDelta !== 0) return statusDelta;
    const severityDelta = severityRank(b.severity) - severityRank(a.severity);
    if (severityDelta !== 0) return severityDelta;
    return a.id.localeCompare(b.id);
  });
}

export function devQueueItemFromIssue(issue, sourcePointer) {
  const normalized = normalizeQaIssue(issue);
  return {
    ...normalized,
    source_pointer: sourcePointer ?? normalized.source_pointer,
  };
}

export function issueSourcePointer(kind, targetId, issueId) {
  return `${kind}:${targetId}:${issueId}`;
}

export function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}
