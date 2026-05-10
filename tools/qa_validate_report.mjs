#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fileExists,
  pngDimensions,
  readJson,
  scoreKeys,
  severityRank,
} from './qa_lib.mjs';

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
const htmlReportPath = process.env.QA_HTML_REPORT_PATH ?? join(reportDir, 'report.html');
const calibrationHtmlPath = process.env.QA_CALIBRATION_HTML_PATH ?? join(reportDir, 'calibration.html');
const liveStatusPath = process.env.QA_LIVE_STATUS_PATH ?? join(reportDir, 'qa_live_status.json');
const expectedFinalStatus = process.env.QA_EXPECT_FINAL_STATUS ?? 'pass';
const qaMode = process.env.QA_MODE ?? 'full';
const strictPass = expectedFinalStatus === 'pass';
const finalPassAllowed = qaMode === 'full' && strictPass;
const userRegressionScreenIds = new Set([
  'start',
  'base_status',
  'guardian_dialog',
  'location_dialog',
  'outing',
]);

const errors = [];
const warnings = [];
const matrix = await readJson(matrixPath);
const playthroughMatrix = await readJson(playthroughMatrixPath);
const screens = matrix.screens ?? [];
const flows = playthroughMatrix.flows ?? [];
let capture = null;
let requiredScreens = screens;
let automatedGateBlocksCodex = false;
let calibrationCandidatesDoc = null;
let calibrationProfile = null;
let calibrationCandidates = [];
let fixedRulesDoc = null;
let fixedRules = [];

validateMatrix();
await loadCaptureResult();
await validateScreenshots();
await validateCaptureResult();
await validatePolishLints();
await validateProductReview();
await validatePlaythroughReview();
await validateFixedRules();
await validateCalibrationCandidates();
await validateLiveStatus();
await validateHtmlReport();

if (warnings.length > 0) {
  console.warn('QA validation warnings:');
  for (const warning of warnings) {
    console.warn(`- ${warning}`);
  }
}

if (errors.length > 0) {
  console.error('QA validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('QA validation passed.');

function validateMatrix() {
  const ids = new Set();
  if (screens.length !== 25) {
    errors.push(`qa_matrix row count must be 25, got ${screens.length}.`);
  }
  for (const screen of screens) {
    if (ids.has(screen.id)) {
      errors.push(`duplicate screen id: ${screen.id}`);
    }
    ids.add(screen.id);
    for (const field of ['acceptanceCriteria', 'knownRiskPatterns', 'requiredEvidence', 'expected', 'implementedEvidence', 'forbidden', 'contractChecks', 'failIfMissing', 'failIfPresent']) {
      if (!Array.isArray(screen[field]) || screen[field].length === 0) {
        errors.push(`qa_matrix ${screen.id} missing ${field}.`);
      }
    }
    if (!screen.fastQaGroup) {
      errors.push(`qa_matrix ${screen.id} missing fastQaGroup.`);
    }
    if (!screen.qaCost) {
      errors.push(`qa_matrix ${screen.id} missing qaCost.`);
    }
  }
  if (flows.length === 0) {
    errors.push('qa_playthrough_matrix must contain required flows.');
  }
}

async function loadCaptureResult() {
  if (!(await fileExists(captureResultPath))) {
    errors.push('capture_result.json is required.');
    automatedGateBlocksCodex = true;
    return;
  }
  capture = await readJson(captureResultPath);
  if (qaMode === 'fast') {
    const capturedIds = new Set((capture.results ?? []).map((result) => result.id));
    requiredScreens = screens.filter((screen) => capturedIds.has(screen.id));
    if (requiredScreens.length === 0) {
      errors.push('QA_MODE=fast requires at least one captured screen row.');
    }
  }
}

async function validateScreenshots() {
  for (const screen of requiredScreens) {
    const path = join(screenshotDir, screen.screenshot);
    if (!(await fileExists(path))) {
      errors.push(`missing screenshot for ${screen.id}: ${screen.screenshot}`);
      continue;
    }
    const fileStat = await stat(path);
    if (fileStat.size < 2500) {
      errors.push(`screenshot too small for ${screen.id}: ${fileStat.size} bytes`);
    }
    const dimensions = pngDimensions(await readFile(path));
    if (
      dimensions.width !== matrix.viewport.width ||
      dimensions.height !== matrix.viewport.height
    ) {
      errors.push(
        `dimension mismatch for ${screen.id}: ${dimensions.width}x${dimensions.height}`,
      );
    }
  }
}

async function validateCaptureResult() {
  if (!capture) return;
  if (qaMode === 'full' && (capture.expected_count !== screens.length || capture.captured_count !== screens.length)) {
    errors.push(
      `capture count mismatch: expected ${screens.length}, got ${capture.captured_count}/${capture.expected_count}`,
    );
  }
  if (qaMode === 'fast' && expectedFinalStatus === 'pass') {
    errors.push('QA_MODE=fast cannot declare final PASS.');
  }
  const byId = new Map((capture.results ?? []).map((result) => [result.id, result]));
  for (const screen of requiredScreens) {
    const result = byId.get(screen.id);
    if (!result) {
      errors.push(`capture result missing row: ${screen.id}`);
      continue;
    }
    const acceptableStatuses = qaMode === 'fast' ? ['captured', 'skipped_cached'] : ['captured'];
    if (!acceptableStatuses.includes(result.status)) {
      automatedGateBlocksCodex = true;
      errors.push(`capture failed for ${screen.id}: ${result.error ?? result.status ?? 'unknown error'}`);
    }
    if (result.screenshot !== screen.screenshot) {
      errors.push(`capture screenshot mismatch for ${screen.id}`);
    }
    if (result.width !== matrix.viewport.width || result.height !== matrix.viewport.height) {
      errors.push(`capture viewport mismatch for ${screen.id}`);
    }
    const screenshotPath = join(screenshotDir, screen.screenshot);
    if (await fileExists(screenshotPath)) {
      const fileStat = await stat(screenshotPath);
      if (Number.isFinite(result.bytes) && result.bytes !== fileStat.size) {
        errors.push(`capture result is stale for ${screen.id}: byte size changed`);
      }
    }
  }
}

async function validatePolishLints() {
  if (!(await fileExists(polishLintsPath))) {
    errors.push('polish_lints.json is required.');
    automatedGateBlocksCodex = true;
    return;
  }
  const lints = await readJson(polishLintsPath);
  const byId = new Map((lints.results ?? []).map((result) => [result.id, result]));
  for (const screen of requiredScreens) {
    const result = byId.get(screen.id);
    if (!result) {
      errors.push(`polish lint missing row: ${screen.id}`);
      continue;
    }
    const severe = (result.findings ?? []).filter(
      (finding) => severityRank(finding.severity) >= severityRank('P2'),
    );
    if (result.status === 'fail' || severe.length > 0) {
      automatedGateBlocksCodex = true;
    }
    if (finalPassAllowed && (result.status !== 'pass' || severe.length > 0)) {
      errors.push(
        `polish lint not pass for ${screen.id}: ${result.status}, ${severe.length} P2+ finding(s)`,
      );
    }
  }
}

async function validateProductReview() {
  if (!(await fileExists(productReviewPath))) {
    if (!finalPassAllowed) {
      warnings.push(
        automatedGateBlocksCodex
          ? 'codex_product_review.json skipped because automated gate blocks Codex review entry.'
          : 'codex_product_review.json not required until final PASS validation.',
      );
      return;
    }
    errors.push('codex_product_review.json is required.');
    return;
  }
  const review = await readJson(productReviewPath);
  if (review.reviewed_by !== 'Codex') {
    errors.push('codex_product_review.json reviewed_by must be Codex.');
  }
  if (finalPassAllowed && review.status !== 'pass') {
    errors.push(`codex product review status must be pass, got ${review.status}.`);
  }
  const byId = new Map((review.screens ?? []).map((result) => [result.id, result]));
  const requiredScoreKeys = scoreKeys();
  let scoreFiveCount = 0;
  let scoreCount = 0;
  for (const screen of requiredScreens) {
    const result = byId.get(screen.id);
    if (!result) {
      errors.push(`codex product review missing row: ${screen.id}`);
      continue;
    }
    validateReviewEvidence('codex product review', screen.id, result, screen);
    validateProductReviewNoMeta(screen.id, result);
    if (result.status === 'fail') {
      validateConcreteFailProductEvidence(screen, result);
    }
    if (finalPassAllowed && result.status === 'pass') {
      validateConcreteProductEvidence(screen, result);
    }
    const contract = validateScreenContract(screen, result);
    if (result.status === 'low_confidence' && contract.notObserved.length === 0) {
      errors.push(`LOW_CONFIDENCE for ${screen.id} requires not_observed contract evidence.`);
    }
    if (finalPassAllowed && result.status !== 'pass') {
      errors.push(`codex product review not pass for ${screen.id}: ${result.status}`);
    }
    if (finalPassAllowed && result.ship_readiness !== 'commercial_ready') {
      errors.push(
        `ship_readiness must be commercial_ready for ${screen.id}, got ${result.ship_readiness}`,
      );
    }
    for (const key of requiredScoreKeys) {
      const score = result.scores?.[key];
      if (!Number.isFinite(score)) {
        errors.push(`missing score ${key} for ${screen.id}`);
      } else {
        scoreCount += 1;
        if (score === 5) scoreFiveCount += 1;
        if (finalPassAllowed && score < 4) {
          errors.push(`score ${key} for ${screen.id} must be >= 4, got ${score}`);
        }
      }
    }
    const severe = (result.findings ?? []).filter(
      (finding) => severityRank(finding.severity) >= severityRank('P2'),
    );
    if (finalPassAllowed && contract.failures.length > 0) {
      errors.push(`product contract has failing check(s) for ${screen.id}: ${contract.failures.length}`);
    }
    if (finalPassAllowed && contract.notObserved.length > 0) {
      errors.push(`product contract has not_observed check(s) for ${screen.id}: ${contract.notObserved.length}`);
    }
    if (finalPassAllowed && severe.length > 0) {
      errors.push(`codex review has P2+ finding(s) for ${screen.id}.`);
    }
    if (finalPassAllowed && screen.mustReviewAtOriginalSize && result.reviewed_original !== true) {
      errors.push(`high-risk screen must be reviewed_original=true: ${screen.id}`);
    }
    if (finalPassAllowed && userRegressionScreenIds.has(screen.id) && result.reviewed_original !== true) {
      errors.push(`user regression screen must be reviewed_original=true: ${screen.id}`);
    }
  }
  if (scoreCount > 0 && scoreFiveCount / scoreCount > 0.18) {
    const message = `excessive score=5 usage in codex product review: ${scoreFiveCount}/${scoreCount}`;
    if (finalPassAllowed) errors.push(message);
    else warnings.push(message);
  }
}

async function validatePlaythroughReview() {
  if (!(await fileExists(playthroughReviewPath))) {
    if (!finalPassAllowed) {
      warnings.push(
        automatedGateBlocksCodex
          ? 'codex_playthrough_review.json skipped because automated gate blocks Codex review entry.'
          : 'codex_playthrough_review.json not required until final PASS validation.',
      );
      return;
    }
    errors.push('codex_playthrough_review.json is required.');
    return;
  }
  const review = await readJson(playthroughReviewPath);
  if (review.reviewed_by !== 'Codex') {
    errors.push('codex_playthrough_review.json reviewed_by must be Codex.');
  }
  if (finalPassAllowed && review.status !== 'pass') {
    errors.push(`codex playthrough review status must be pass, got ${review.status}.`);
  }
  const byId = new Map((review.flows ?? []).map((result) => [result.flow_id, result]));
  const requiredFlows =
    qaMode === 'fast'
      ? flows.filter((flow) => (review.flows ?? []).some((result) => result.flow_id === flow.id))
      : flows;
  let scoreFiveCount = 0;
  let scoreCount = 0;
  for (const flow of requiredFlows) {
    const result = byId.get(flow.id);
    if (!result) {
      errors.push(`codex playthrough review missing row: ${flow.id}`);
      continue;
    }
    if (isBlank(result.review_note)) {
      errors.push(`codex playthrough review ${flow.id} missing review_note.`);
    } else if (result.verdict === 'fail') {
      validateConcreteText(`codex playthrough review ${flow.id} review_note`, result.review_note);
    } else if (finalPassAllowed && result.verdict === 'pass') {
      validateConcreteText(`codex playthrough review ${flow.id} review_note`, result.review_note);
    }
    if (!Array.isArray(result.requiredEvidence) || result.requiredEvidence.length === 0) {
      errors.push(`codex playthrough review ${flow.id} missing requiredEvidence.`);
    }
    if (!Array.isArray(result.transcript) || result.transcript.length === 0) {
      errors.push(`codex playthrough review ${flow.id} missing transcript.`);
    } else if (result.verdict === 'fail') {
      validateTranscript(flow.id, result.transcript);
    } else if (finalPassAllowed && result.verdict === 'pass') {
      validateTranscript(flow.id, result.transcript);
    }
    if (isBlank(result.recommended_fix)) {
      errors.push(`codex playthrough review ${flow.id} missing recommended_fix.`);
    } else if (result.verdict === 'fail') {
      validateConcreteText(`codex playthrough review ${flow.id} recommended_fix`, result.recommended_fix);
    } else if (finalPassAllowed && result.verdict === 'pass') {
      validateConcreteText(`codex playthrough review ${flow.id} recommended_fix`, result.recommended_fix);
    }
    validatePlaythroughReviewNoMeta(flow.id, result);
    if (result.verdict === 'fail') {
      validateConcreteFailPlaythroughEvidence(flow.id, result);
    }
    const contract = validateFlowContract(flow.id, result);
    if (result.verdict === 'low_confidence' && contract.notObserved.length === 0) {
      errors.push(`LOW_CONFIDENCE for playthrough ${flow.id} requires not_observed contract evidence.`);
    }
    if (finalPassAllowed && result.verdict !== 'pass') {
      errors.push(`codex playthrough review not pass for ${flow.id}: ${result.verdict}`);
    }
    for (const key of playthroughMatrix.requiredScoreKeys ?? []) {
      const score = result.scenario_scores?.[key];
      if (!Number.isFinite(score)) {
        errors.push(`missing playthrough score ${key} for ${flow.id}`);
      } else {
        scoreCount += 1;
        if (score === 5) scoreFiveCount += 1;
        if (finalPassAllowed && score < 4) {
          errors.push(`playthrough score ${key} for ${flow.id} must be >= 4, got ${score}`);
        }
      }
    }
    const severe = (result.findings ?? []).filter(
      (finding) => severityRank(finding.severity) >= severityRank('P2'),
    );
    if (finalPassAllowed && contract.failures.length > 0) {
      errors.push(`playthrough contract has failing check(s) for ${flow.id}: ${contract.failures.length}`);
    }
    if (finalPassAllowed && contract.notObserved.length > 0) {
      errors.push(`playthrough contract has not_observed check(s) for ${flow.id}: ${contract.notObserved.length}`);
    }
    if (finalPassAllowed && severe.length > 0) {
      errors.push(`codex playthrough review has P2+ finding(s) for ${flow.id}.`);
    }
    if (finalPassAllowed && result.verdict === 'pass') {
      for (const group of ['expectedFlow', 'observedFlow', 'forbiddenFlowBreaks']) {
        for (const row of result[group] ?? []) {
          validateConcreteText(`codex playthrough review ${flow.id} ${group} ${row.id} note`, row.note);
        }
      }
    }
  }
  if (scoreCount > 0 && scoreFiveCount / scoreCount > 0.18) {
    const message = `excessive score=5 usage in codex playthrough review: ${scoreFiveCount}/${scoreCount}`;
    if (finalPassAllowed) errors.push(message);
    else warnings.push(message);
  }
}

async function validateLiveStatus() {
  if (!finalPassAllowed) return;
  if (!(await fileExists(liveStatusPath))) {
    errors.push('qa_live_status.json is required for final PASS validation.');
    return;
  }
  const liveStatus = await readJson(liveStatusPath);
  const requiredFields = ['targetWorktree', 'reportDir', 'screenshotDir', 'finalStatus'];
  for (const field of requiredFields) {
    if (isBlank(liveStatus[field])) {
      errors.push(`qa_live_status.json missing ${field} for final PASS validation.`);
    }
  }
  if (!Number.isFinite(liveStatus.screenshotCount) || liveStatus.screenshotCount <= 0) {
    errors.push('qa_live_status.json missing positive screenshotCount for final PASS validation.');
  }
  if (liveStatus.finalStatus !== 'PASS') {
    errors.push(`qa_live_status.json finalStatus must be PASS, got ${liveStatus.finalStatus ?? 'missing'}.`);
  }
}

async function validateCalibrationCandidates() {
  if (!(await fileExists(calibrationCandidatesPath))) {
    if (!finalPassAllowed) {
      warnings.push('qa_calibration_candidates.json is missing; calibration loop is not active for this report.');
    }
    return;
  }
  calibrationCandidatesDoc = await readJson(calibrationCandidatesPath);
  calibrationProfile = (await fileExists(calibrationProfilePath))
    ? normalizeCalibrationProfile(await readJson(calibrationProfilePath))
    : normalizeCalibrationProfile({});
  calibrationCandidates = calibrationCandidatesDoc.candidates ?? [];
  if (!Array.isArray(calibrationCandidates) || calibrationCandidates.length === 0) {
    errors.push('qa_calibration_candidates.json must contain calibration candidates.');
    return;
  }
  const allowedScreens = new Set(['start', 'base_status', 'guardian_dialog', 'location_dialog', 'outing']);
  const allowedFlows = new Set([
    'user_regression_flow',
    'first_report_flow',
    'ending_cycle1_flow',
    'ending_cycle2_flow',
    'ending_cycle3_flow',
  ]);
  const allowedGlobalTargets = new Set(['global_visual_chrome']);
  const ids = new Set();
  for (const candidate of calibrationCandidates) {
    if (ids.has(candidate.candidate_id)) {
      errors.push(`duplicate calibration candidate id: ${candidate.candidate_id}`);
    }
    ids.add(candidate.candidate_id);
    if (!/^CAL-[SFG]\d{2}$/.test(candidate.candidate_id ?? '')) {
      errors.push(`invalid calibration candidate id: ${candidate.candidate_id}`);
    }
    if (!['screen_problem', 'play_experience', 'global_visual'].includes(candidate.type)) {
      errors.push(`invalid calibration candidate type for ${candidate.candidate_id}: ${candidate.type}`);
    }
    if (candidate.type === 'screen_problem' && !allowedScreens.has(candidate.target_id)) {
      errors.push(`screen calibration candidate outside first round: ${candidate.candidate_id} ${candidate.target_id}`);
    }
    if (candidate.type === 'play_experience' && !allowedFlows.has(candidate.target_id)) {
      errors.push(`flow calibration candidate outside first round: ${candidate.candidate_id} ${candidate.target_id}`);
    }
    if (candidate.type === 'global_visual' && !allowedGlobalTargets.has(candidate.target_id)) {
      errors.push(`global calibration candidate outside first round: ${candidate.candidate_id} ${candidate.target_id}`);
    }
    for (const field of ['title', 'evidence', 'problem_claim', 'suggested_fix', 'answer_template']) {
      if (isBlank(candidate[field])) {
        errors.push(`calibration candidate ${candidate.candidate_id} missing ${field}.`);
      } else if (field === 'title' && !hasHangul(candidate[field])) {
        errors.push(`calibration candidate ${candidate.candidate_id} title must be written in Korean.`);
      } else if (field !== 'title') {
        validateConcreteText(`calibration candidate ${candidate.candidate_id} ${field}`, candidate[field]);
      }
    }
    const expectedStatus = calibrationStatusForCandidate(candidate.candidate_id);
    if ((candidate.calibration_status ?? 'pending') !== expectedStatus) {
      errors.push(
        `calibration candidate ${candidate.candidate_id} status mismatch: expected ${expectedStatus}, got ${candidate.calibration_status ?? 'pending'}`,
      );
    }
    validateCandidateLearnedRules(candidate, expectedStatus);
  }
  const knownIds = new Set(calibrationCandidates.map((candidate) => candidate.candidate_id));
  for (const id of [
    ...arraySet(calibrationProfile.accepted),
    ...arraySet(calibrationProfile.rejected),
    ...needsRewriteSet(calibrationProfile),
    ...deferredSet(calibrationProfile),
    ...objectKeysSet(calibrationProfile.learned_rules),
    ...objectKeysSet(calibrationProfile.rewrites),
    ...objectKeysSet(calibrationProfile.notes),
    ...objectKeysSet(calibrationProfile.priority_overrides),
  ]) {
    if (!knownIds.has(id)) {
      errors.push(`qa_calibration_profile references unknown candidate: ${id}`);
    }
  }
  await validateCalibrationQueuePromotion();
}

async function validateCalibrationQueuePromotion() {
  if (finalPassAllowed) return;
  const productReview = (await fileExists(productReviewPath)) ? await readJson(productReviewPath) : { screens: [] };
  const playthroughReview = (await fileExists(playthroughReviewPath)) ? await readJson(playthroughReviewPath) : { flows: [] };
  const productById = new Map((productReview.screens ?? []).map((screen) => [screen.id, screen]));
  const flowById = new Map((playthroughReview.flows ?? []).map((flow) => [flow.flow_id, flow]));
  const globalFindings = productReview.global_visual_findings ?? [];
  const fixedRuleIds = new Set(fixedRules.map((rule) => rule.rule_id));
  const fixedRuleModeActive =
    (productReview.screens ?? []).some((screen) => (screen.fixed_rules ?? []).length > 0) ||
    (playthroughReview.flows ?? []).some((flow) => (flow.fixed_rules ?? []).length > 0) ||
    globalFindings.length > 0;
  if (fixedRuleModeActive) {
    for (const rule of fixedRules) {
      const findings = findingsForRule(rule, { productById, flowById, globalFindings });
      if (findings.length === 0) {
        errors.push(`fixed QA rule missing finding: ${rule.rule_id}`);
        continue;
      }
      for (const finding of findings) {
        validateFixedRuleFinding(`fixed QA rule finding ${rule.rule_id}`, finding);
      }
    }
  }
  for (const [targetId, result] of productById) {
    for (const finding of result.findings ?? []) {
      if (finding.rule_id && !fixedRuleIds.has(finding.rule_id)) {
        errors.push(`product review ${targetId} finding uses unknown fixed rule: ${finding.rule_id}`);
      }
      if (!finding.rule_id && severityRank(finding.severity) >= severityRank('P2')) {
        errors.push(`product review ${targetId} P2+ development finding has no fixed rule_id.`);
      }
    }
  }
  for (const [targetId, result] of flowById) {
    for (const finding of result.findings ?? []) {
      if (finding.rule_id && !fixedRuleIds.has(finding.rule_id)) {
        errors.push(`playthrough review ${targetId} finding uses unknown fixed rule: ${finding.rule_id}`);
      }
      if (!finding.rule_id && severityRank(finding.severity) >= severityRank('P2')) {
        errors.push(`playthrough review ${targetId} P2+ development finding has no fixed rule_id.`);
      }
    }
  }
  for (const finding of globalFindings) {
    if (!finding.rule_id || !fixedRuleIds.has(finding.rule_id)) {
      errors.push(`global visual finding has no known fixed rule_id: ${finding.rule_id ?? 'missing'}`);
    }
  }
  for (const candidateId of arraySet(calibrationProfile?.accepted)) {
    const candidate = calibrationCandidates.find((item) => item.candidate_id === candidateId);
    const hasFixedRule = fixedRules.some((rule) => rule.source_candidate_id === candidateId);
    if (!hasFixedRule && candidateAppearsPromoted(candidate, { productById, flowById, globalFindings })) {
      errors.push(`profile accepted candidate cannot enter development queue without fixed QA rule: ${candidateId}`);
    }
  }
}

async function validateFixedRules() {
  if (!(await fileExists(fixedRulesPath))) {
    if (!finalPassAllowed) {
      errors.push('tools/qa_fixed_rules.json is required for fixed QA rule queue validation.');
      return;
    }
    errors.push('tools/qa_fixed_rules.json is required.');
    return;
  }
  fixedRulesDoc = await readJson(fixedRulesPath);
  fixedRules = Array.isArray(fixedRulesDoc.rules) ? fixedRulesDoc.rules : [];
  if (fixedRules.length === 0) {
    errors.push('tools/qa_fixed_rules.json must contain at least one fixed QA rule.');
    return;
  }
  const ids = new Set();
  for (const rule of fixedRules) {
    for (const field of ['rule_id', 'source_candidate_id', 'type', 'target_id', 'assertion', 'observed_evidence', 'pass_criteria', 'recommended_fix', 'severity']) {
      if (isBlank(rule[field])) {
        errors.push(`fixed QA rule missing ${field}: ${rule.rule_id ?? 'unknown'}`);
      }
    }
    if (ids.has(rule.rule_id)) {
      errors.push(`duplicate fixed QA rule id: ${rule.rule_id}`);
    }
    ids.add(rule.rule_id);
    if (!/^[-a-z0-9_]+$/.test(rule.rule_id ?? '')) {
      errors.push(`fixed QA rule id must be snake_case-like: ${rule.rule_id}`);
    }
    if (!['screen_problem', 'play_experience', 'global_visual'].includes(rule.type)) {
      errors.push(`fixed QA rule ${rule.rule_id} has invalid type: ${rule.type}`);
    }
    for (const field of ['assertion', 'observed_evidence', 'pass_criteria', 'recommended_fix']) {
      validateConcreteText(`fixed QA rule ${rule.rule_id} ${field}`, rule[field]);
    }
    if (!['P0', 'P1', 'P2', 'P3'].includes(rule.severity)) {
      errors.push(`fixed QA rule ${rule.rule_id} invalid severity: ${rule.severity}`);
    }
  }
  const calS02Rules = new Set(
    fixedRules
      .filter((rule) => rule.source_candidate_id === 'CAL-S02')
      .map((rule) => rule.rule_id),
  );
  for (const ruleId of [
    'guardian_portrait_scale_consistency',
    'guardian_portrait_no_crop',
    'guardian_live2d_layered_motion',
    'cta_ssot_contract',
  ]) {
    if (!calS02Rules.has(ruleId)) {
      errors.push(`CAL-S02 fixed QA rule missing: ${ruleId}`);
    }
  }
}

function findingsForRule(rule, { productById, flowById, globalFindings }) {
  if (rule.type === 'screen_problem') {
    return (productById.get(rule.target_id)?.findings ?? []).filter((finding) => finding.rule_id === rule.rule_id);
  }
  if (rule.type === 'play_experience') {
    return (flowById.get(rule.target_id)?.findings ?? []).filter((finding) => finding.rule_id === rule.rule_id);
  }
  if (rule.type === 'global_visual') {
    return (globalFindings ?? []).filter((finding) => finding.rule_id === rule.rule_id);
  }
  return [];
}

function candidateAppearsPromoted(candidate, { productById, flowById, globalFindings }) {
  if (!candidate) return false;
  if (candidate.type === 'screen_problem') {
    const result = productById.get(candidate.target_id);
    return result?.status === 'fail' || hasP2Plus(result?.findings);
  }
  if (candidate.type === 'play_experience') {
    const result = flowById.get(candidate.target_id);
    return result?.verdict === 'fail' || hasP2Plus(result?.findings);
  }
  if (candidate.type === 'global_visual') {
    return (globalFindings ?? []).some((finding) => finding.source_candidate_id === candidate.candidate_id);
  }
  return false;
}

async function validateHtmlReport() {
  if (!(await fileExists(htmlReportPath))) {
    errors.push('report.html is required.');
    return;
  }
  const html = await readFile(htmlReportPath, 'utf8');
  const requiredTexts = [
    'Dragonout QA Report',
    '자동 검사 게이트',
    'Commercial Product QA Gate',
    'Playthrough / Narrative QA',
    '수정 큐',
  ];
  if (finalPassAllowed) {
    requiredTexts.push('최종 상태: PASS', 'Codex visual/product review completed', 'Codex playthrough review completed', 'commercial_ready');
  } else if (qaMode === 'fast') {
    requiredTexts.push('부분 검수 완료');
    if (html.includes('최종 상태: PASS')) {
      errors.push('Fast QA report must not contain final PASS text.');
    }
  } else {
    requiredTexts.push('최종 상태: QA 미통과');
  }
  if (automatedGateBlocksCodex && !finalPassAllowed) {
    requiredTexts.push('자동 검사 FAIL', 'Codex 제품 검수 미진입');
  }
  requiredTexts.push('고정 QA 룰', 'QA 판정 항목', '전체 QA 판정 항목', 'qa-matrix-grid', 'qa-card');
  for (const requiredText of requiredTexts) {
    if (!html.includes(requiredText)) {
      errors.push(`report.html missing required text: ${requiredText}`);
    }
  }
  for (const forbiddenText of ['캘리브레이션 후보표', 'profile JSON 복사', 'calibrationSaveButton', 'type="radio"']) {
    if (html.includes(forbiddenText)) {
      errors.push(`report.html must not expose calibration setup UI: ${forbiddenText}`);
    }
  }
  for (const forbiddenText of ['<th>계약 위반</th>', '계약 위반 없음', '실패와 증거 부족 없이', '기대 항목 미충족', '구현 증거 부족']) {
    if (html.includes(forbiddenText)) {
      errors.push(`report.html must not expose generic QA judgement text: ${forbiddenText}`);
    }
  }
  if (!finalPassAllowed && await hasFixedRuleModeActive()) {
    const fixedRuleIds = fixedRules.map((rule) => rule.rule_id);
    for (const ruleId of fixedRuleIds) {
      if (!html.includes(ruleId)) {
        errors.push(`report.html missing fixed QA rule id in development queue: ${ruleId}`);
      }
    }
    for (const ruleId of [
      'guardian_portrait_scale_consistency',
      'guardian_portrait_no_crop',
      'guardian_live2d_layered_motion',
      'cta_ssot_contract',
    ]) {
      if (!html.includes(ruleId)) {
        errors.push(`report.html missing CAL-S02 regression rule id: ${ruleId}`);
      }
    }
  }
  for (const screen of requiredScreens) {
    if (!html.includes(screen.screenshot)) {
      errors.push(`report.html missing screenshot reference: ${screen.screenshot}`);
    }
  }
  await validateCalibrationSetupHtml();
}

async function hasFixedRuleModeActive() {
  const productReview = (await fileExists(productReviewPath)) ? await readJson(productReviewPath) : { screens: [] };
  const playthroughReview = (await fileExists(playthroughReviewPath)) ? await readJson(playthroughReviewPath) : { flows: [] };
  return (
    (productReview.screens ?? []).some((screen) => (screen.fixed_rules ?? []).length > 0) ||
    (productReview.global_visual_findings ?? []).length > 0 ||
    (playthroughReview.flows ?? []).some((flow) => (flow.fixed_rules ?? []).length > 0)
  );
}

async function validateCalibrationSetupHtml() {
  if (!(await fileExists(calibrationHtmlPath))) {
    errors.push('calibration.html is required as separate QA hurdle setup output.');
    return;
  }
  const html = await readFile(calibrationHtmlPath, 'utf8');
  for (const requiredText of ['Dragonout QA 허들 설정', '허들 설정 후보', '룰 draft', '현재 캡처/흐름 검출 결과', '고정', '재작성', '기각', 'CAL-S02']) {
    if (!html.includes(requiredText)) {
      errors.push(`calibration.html missing setup text: ${requiredText}`);
    }
  }
  for (const ruleId of [
    'guardian_portrait_scale_consistency',
    'guardian_portrait_no_crop',
    'guardian_live2d_layered_motion',
    'cta_ssot_contract',
  ]) {
    if (!html.includes(ruleId)) {
      errors.push(`calibration.html missing CAL-S02 rule draft: ${ruleId}`);
    }
  }
  const normalReport = await readFile(htmlReportPath, 'utf8');
  if (normalReport.includes('calibration.html') || normalReport.includes('/calibration')) {
    errors.push('report.html must not link to calibration setup output.');
  }
}

function validateReviewEvidence(label, id, result, screen) {
  if (result.status === 'unchecked') {
    errors.push(`${label} ${id} is unchecked.`);
  }
  if (isBlank(result.review_note) && isBlank(result.rationale)) {
    errors.push(`${label} ${id} missing review_note/rationale.`);
  }
  if (isBlank(result.recommended_fix)) {
    errors.push(`${label} ${id} missing recommended_fix.`);
  }
  if (!Array.isArray(result.requiredEvidence) || result.requiredEvidence.length === 0) {
    errors.push(`${label} ${id} missing requiredEvidence.`);
  }
  if (Array.isArray(screen.requiredEvidence)) {
    for (const evidence of screen.requiredEvidence) {
      if (!result.requiredEvidence?.some((value) => String(value).includes(evidence) || String(evidence).includes(value))) {
        if (finalPassAllowed) {
          errors.push(`${label} ${id} missing required evidence: ${evidence}`);
        }
      }
    }
  }
}

function validateConcreteProductEvidence(screen, result) {
  const screenshotName = screen.screenshot;
  const combinedReviewText = [
    result.review_note,
    result.rationale,
    result.recommended_fix,
  ].filter(Boolean).join(' ');
  validateConcreteText(`codex product review ${screen.id} review_note`, result.review_note);
  validateConcreteText(`codex product review ${screen.id} rationale`, result.rationale);
  validateConcreteText(`codex product review ${screen.id} recommended_fix`, result.recommended_fix);
  if (!combinedReviewText.includes(screenshotName)) {
    errors.push(`codex product review ${screen.id} must mention screenshot ${screenshotName} in concrete evidence.`);
  }
  for (const group of ['expected', 'implementedEvidence', 'forbidden']) {
    for (const row of result.contract_results?.[group] ?? []) {
      validateConcreteText(`codex product review ${screen.id} ${group} ${row.id} note`, row.note);
    }
  }
}

function validateConcreteFailProductEvidence(screen, result) {
  validateConcreteText(`codex product review ${screen.id} fail review_note`, result.review_note);
  validateConcreteText(`codex product review ${screen.id} fail recommended_fix`, result.recommended_fix);
  const severe = (result.findings ?? []).filter(
    (finding) => severityRank(finding.severity) >= severityRank('P2'),
  );
  if (severe.length === 0) {
    errors.push(`codex product review ${screen.id} FAIL requires at least one P2+ concrete finding.`);
  }
  for (const finding of severe) {
    validateConcreteText(`codex product review ${screen.id} finding ${finding.code}`, finding.message);
    validateFixedRuleFinding(`codex product review ${screen.id} finding ${finding.code}`, finding);
  }
}

function validateConcreteFailPlaythroughEvidence(id, result) {
  const severe = (result.findings ?? []).filter(
    (finding) => severityRank(finding.severity) >= severityRank('P2'),
  );
  if (severe.length === 0) {
    errors.push(`codex playthrough review ${id} FAIL requires at least one P2+ concrete finding.`);
  }
  for (const finding of severe) {
    validateConcreteText(`codex playthrough review ${id} finding ${finding.code}`, finding.message);
    validateFixedRuleFinding(`codex playthrough review ${id} finding ${finding.code}`, finding);
  }
}

function validateFixedRuleFinding(label, finding) {
  for (const field of ['rule_id', 'target_id', 'observed_evidence', 'pass_criteria', 'severity']) {
    if (isBlank(finding[field])) {
      errors.push(`${label} missing fixed rule field ${field}.`);
    }
  }
  if (!isBlank(finding.rule_id) && !/^[-a-z0-9_]+$/.test(finding.rule_id)) {
    errors.push(`${label} rule_id must be snake_case-like: ${finding.rule_id}`);
  }
  if (!isBlank(finding.observed_evidence)) {
    validateConcreteText(`${label} observed_evidence`, finding.observed_evidence);
  }
  if (!isBlank(finding.pass_criteria)) {
    validateConcreteText(`${label} pass_criteria`, finding.pass_criteria);
  }
  validateFindingDoesNotCopyUserNotes(label, finding);
}

function validateCandidateLearnedRules(candidate, status) {
  const rules = Array.isArray(candidate.learned_rules) ? candidate.learned_rules : [];
  if (status === 'accepted' && rules.length === 0) {
    errors.push(`accepted calibration candidate requires learned QA rule(s): ${candidate.candidate_id}`);
  }
  for (const rule of rules) {
    for (const field of ['rule_id', 'assertion', 'current_observation', 'pass_criteria']) {
      if (isBlank(rule[field])) {
        errors.push(`learned QA rule for ${candidate.candidate_id} missing ${field}.`);
      } else if (field !== 'rule_id') {
        validateConcreteText(`learned QA rule ${candidate.candidate_id} ${field}`, rule[field]);
      }
    }
    if (!/^[-a-z0-9_]+$/.test(rule.rule_id ?? '')) {
      errors.push(`learned QA rule id must be snake_case-like for ${candidate.candidate_id}: ${rule.rule_id}`);
    }
  }
}

function validateAcceptedRulePromotion(candidate, findings, ruleIds) {
  if (ruleIds.size === 0) {
    errors.push(`accepted calibration candidate has no learned QA rule ids: ${candidate.candidate_id}`);
    return;
  }
  const findingRuleIds = new Set((findings ?? []).map((finding) => finding.rule_id).filter(Boolean));
  for (const ruleId of ruleIds) {
    if (!findingRuleIds.has(ruleId)) {
      errors.push(`accepted calibration candidate missing learned rule finding: ${candidate.candidate_id} ${ruleId}`);
    }
  }
}

function candidateRuleIds(candidate) {
  return new Set((candidate.learned_rules ?? []).map((rule) => rule.rule_id).filter(Boolean));
}

function validateProductReviewNoMeta(id, result) {
  const fields = [
    ['review_note', result.review_note],
    ['rationale', result.rationale],
    ['recommended_fix', result.recommended_fix],
    ...(result.findings ?? []).map((finding) => [`finding ${finding.code}`, finding.message]),
  ];
  for (const group of ['expected', 'implementedEvidence', 'forbidden']) {
    for (const row of result.contract_results?.[group] ?? []) {
      fields.push([`${group} ${row.id} note`, row.note]);
    }
  }
  for (const [field, value] of fields) {
    if (isMetaFailureText(value)) {
      errors.push(`codex product review ${id} ${field} contains meta failure text.`);
    }
  }
}

function validatePlaythroughReviewNoMeta(id, result) {
  const fields = [
    ['review_note', result.review_note],
    ['recommended_fix', result.recommended_fix],
    ...(result.transcript ?? []).map((row, index) => [`transcript ${index + 1}`, row]),
    ...(result.findings ?? []).map((finding) => [`finding ${finding.code}`, finding.message]),
  ];
  for (const group of ['expectedFlow', 'observedFlow', 'forbiddenFlowBreaks']) {
    for (const row of result[group] ?? []) {
      fields.push([`${group} ${row.id} note`, row.note]);
    }
  }
  for (const [field, value] of fields) {
    if (isMetaFailureText(value)) {
      errors.push(`codex playthrough review ${id} ${field} contains meta failure text.`);
    }
  }
}

function validateScreenContract(screen, result) {
  const contract = result.contract_results;
  if (!contract || typeof contract !== 'object') {
    errors.push(`codex product review ${screen.id} missing contract_results.`);
    return { failures: ['missing contract_results'], notObserved: [] };
  }
  const failures = [];
  const notObserved = [];
  for (const group of ['expected', 'implementedEvidence', 'forbidden']) {
    if (!Array.isArray(contract[group])) {
      errors.push(`codex product review ${screen.id} missing contract_results.${group}.`);
      continue;
    }
    for (const row of contract[group]) {
      if (!row.id || !row.status || isBlank(row.note)) {
        errors.push(`codex product review ${screen.id} has incomplete contract row in ${group}.`);
      }
    }
  }
  const expectedResults = new Map((contract.expected ?? []).map((row) => [row.id, row]));
  const evidenceResults = new Map((contract.implementedEvidence ?? []).map((row) => [row.id, row]));
  const forbiddenResults = new Map((contract.forbidden ?? []).map((row) => [row.id, row]));
  for (const item of [...(screen.expected ?? []), ...(screen.implementedEvidence ?? []), ...(screen.forbidden ?? [])]) {
    const resultRow = expectedResults.get(item.id) ?? evidenceResults.get(item.id) ?? forbiddenResults.get(item.id);
    if (!resultRow) {
      errors.push(`codex product review ${screen.id} missing contract result for ${item.id}.`);
    }
  }
  for (const id of screen.failIfMissing ?? []) {
    const row = expectedResults.get(id) ?? evidenceResults.get(id);
    if (!row || row.status === 'not_observed') {
      notObserved.push(id);
    } else if (row.status === 'fail') {
      failures.push(id);
    }
  }
  for (const id of screen.failIfPresent ?? []) {
    const row = forbiddenResults.get(id);
    if (row?.status === 'present' || row?.status === 'fail') {
      failures.push(id);
    }
  }
  return { failures, notObserved };
}

function validateFlowContract(id, result) {
  const failures = [];
  const notObserved = [];
  for (const group of ['expectedFlow', 'observedFlow', 'forbiddenFlowBreaks']) {
    if (!Array.isArray(result[group]) || result[group].length === 0) {
      errors.push(`codex playthrough review ${id} missing ${group}.`);
      continue;
    }
    for (const row of result[group]) {
      if (!row.id || !row.status || isBlank(row.note)) {
        errors.push(`codex playthrough review ${id} has incomplete ${group} row.`);
      }
      if (row.status === 'fail' || row.status === 'present') {
        failures.push(row.id);
      } else if (row.status === 'not_observed') {
        notObserved.push(row.id);
      }
    }
  }
  return { failures, notObserved };
}

function validateTranscript(id, transcript) {
  const combined = transcript.map((row) => String(row)).join(' ');
  validateConcreteText(`codex playthrough review ${id} transcript`, combined);
  if (!transcript.some((row) => hasHangul(row))) {
    errors.push(`codex playthrough review ${id} transcript must include Korean on-screen copy or Korean observation.`);
  }
  for (const row of transcript) {
    if (isGenericEvidenceText(row)) {
      errors.push(`codex playthrough review ${id} transcript contains placeholder text: ${row}`);
    }
  }
}

function validateConcreteText(label, value) {
  if (isBlank(value)) {
    errors.push(`${label} is missing concrete Korean evidence.`);
    return;
  }
  const text = String(value).trim();
  if (!hasHangul(text)) {
    errors.push(`${label} must be written in Korean for user-facing QA evidence.`);
  }
  if (text.length < 18) {
    errors.push(`${label} is too short to be concrete evidence.`);
  }
  if (isGenericEvidenceText(text)) {
    errors.push(`${label} contains generic PASS template text.`);
  }
}

function hasHangul(value) {
  return /[가-힣]/.test(String(value ?? ''));
}

function isGenericEvidenceText(value) {
  const text = String(value ?? '').toLowerCase();
  const genericPatterns = [
    /acceptable/,
    /no (product-|playthrough-)?blocking fix required/,
    /no .*fix required/,
    /screenshot reviewed/,
    /reviewed at 390x844/,
    /latest full qa (capture )?sequence/,
    /reads coherently/,
    /composition, cta hierarchy/,
    /korean wrapping/,
    /dragonout hud treatment are acceptable/,
    /keep .*pass baseline/,
    /observed in final_/,
    /verified in latest full qa artifact/,
    /synthetic validator fixture/,
    /step \d+: .*screenshot reviewed/,
  ];
  return genericPatterns.some((pattern) => pattern.test(text));
}

function isMetaFailureText(value) {
  const text = String(value ?? '');
  const normalized = text.replace(/\s+/g, ' ').trim();
  const metaPatterns = [
    /명백한 크래시는 없지만/,
    /PASS 문턱/,
    /사용자 기준보다/,
    /^재검수가 필요합니다\.?$/,
    /재검수 대상으로/,
    /기존 Codex 제품 검수/,
    /기존 제품 검수/,
    /codex_product_review_fail/,
    /codex_product_score_below_bar/,
    /ship_readiness_needs_polish/,
    /ship_readiness_prototype_quality/,
    /screenshot reviewed/i,
  ];
  return metaPatterns.some((pattern) => pattern.test(normalized));
}

function validateFindingDoesNotCopyUserNotes(label, finding) {
  const userTexts = userCalibrationTexts();
  if (userTexts.length === 0) return;
  for (const field of ['message', 'observed_evidence', 'pass_criteria']) {
    const value = normalizeCompareText(finding[field]);
    if (!value) continue;
    for (const userText of userTexts) {
      if (value === userText) {
        errors.push(`${label} ${field} copies user calibration note instead of detector evidence.`);
      }
    }
  }
}

function userCalibrationTexts() {
  if (!calibrationProfile) return [];
  const values = [
    ...Object.values(calibrationProfile.notes ?? {}),
    ...Object.values(calibrationProfile.needs_rewrite ?? {}),
    ...Object.values(calibrationProfile.deferred ?? {}),
    ...Object.values(calibrationProfile.priority_overrides ?? {}),
  ];
  for (const rewrite of Object.values(calibrationProfile.rewrites ?? {})) {
    if (rewrite && typeof rewrite === 'object' && !Array.isArray(rewrite)) {
      values.push(...Object.values(rewrite));
    }
  }
  return values
    .map(normalizeCompareText)
    .filter((text) => text.length >= 18);
}

function normalizeCompareText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function calibrationStatusForCandidate(candidateId) {
  if (arraySet(calibrationProfile?.accepted).has(candidateId)) return 'accepted';
  if (arraySet(calibrationProfile?.rejected).has(candidateId)) return 'rejected';
  if (needsRewriteSet(calibrationProfile).has(candidateId)) return 'needs_rewrite';
  if (deferredSet(calibrationProfile).has(candidateId)) return 'deferred';
  return 'pending';
}

function normalizeCalibrationProfile(value) {
  return {
    version: value?.version ?? 2,
    accepted: Array.isArray(value?.accepted) ? value.accepted : [],
    rejected: Array.isArray(value?.rejected) ? value.rejected : [],
    needs_rewrite: normalizeNoteMap(value?.needs_rewrite),
    deferred: normalizeNoteMap(value?.deferred),
    notes: normalizeNoteMap(value?.notes),
    rewrites: normalizeObjectMap(value?.rewrites),
    learned_rules: normalizeObjectMap(value?.learned_rules),
    priority_overrides: normalizeNoteMap(value?.priority_overrides),
  };
}

function hasP2Plus(findings) {
  return (findings ?? []).some((finding) => severityRank(finding.severity) >= severityRank('P2'));
}

function arraySet(value) {
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

function needsRewriteSet(profile) {
  if (Array.isArray(profile?.needs_rewrite)) return arraySet(profile.needs_rewrite);
  return new Set(Object.keys(profile?.needs_rewrite ?? {}));
}

function deferredSet(profile) {
  if (Array.isArray(profile?.deferred)) return arraySet(profile.deferred);
  return new Set(Object.keys(profile?.deferred ?? {}));
}

function objectKeysSet(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Set();
  return new Set(Object.keys(value));
}

function normalizeNoteMap(value) {
  if (Array.isArray(value)) return Object.fromEntries(value.map((id) => [String(id), '']));
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).map(([key, note]) => [String(key), String(note ?? '')]));
}

function normalizeObjectMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}
