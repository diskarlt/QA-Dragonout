#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readJson } from './qa_lib.mjs';
import {
  QA_QUEUE_STATUSES,
  REGRESSION_LOCK_SCREEN_IDS,
  REQUIRED_BASE_STATUS_RULE_IDS,
  blockedIssue,
  dedupeIssues,
  devQueueItemFromIssue,
  issueFromFixedRule,
  issueSourcePointer,
  normalizeIssues,
  normalizeQaIssue,
  targetTypeForRule,
} from './qa_queue_model.mjs';

const reportDir = resolve(
  process.env.QA_REPORT_DIR ?? 'docs/qa/reports/2026-05-09-ui-qa-pipeline',
);
const matrixPath = process.env.QA_MATRIX_PATH ?? 'tools/qa_matrix.json';
const playthroughMatrixPath =
  process.env.QA_PLAYTHROUGH_MATRIX_PATH ?? 'tools/qa_playthrough_matrix.json';
const productReviewPath =
  process.env.QA_PRODUCT_REVIEW_PATH ?? join(reportDir, 'codex_product_review.json');
const playthroughReviewPath =
  process.env.QA_PLAYTHROUGH_REVIEW_PATH ?? join(reportDir, 'codex_playthrough_review.json');
const fixedRulesPath = process.env.QA_FIXED_RULES_PATH ?? 'tools/qa_fixed_rules.json';
const devQueuePath = process.env.QA_DEV_QUEUE_PATH ?? join(reportDir, 'dev_queue.json');
const regressionLockPath =
  process.env.QA_REGRESSION_LOCK_PATH ?? join(reportDir, 'regression_lock.json');

const matrix = await readJson(matrixPath);
const playthroughMatrix = await readJson(playthroughMatrixPath);
const productReview = await readJson(productReviewPath);
const playthroughReview = await readJson(playthroughReviewPath);
const fixedRulesDoc = await readJson(fixedRulesPath);
const fixedRules = Array.isArray(fixedRulesDoc.rules) ? fixedRulesDoc.rules : [];
const now = new Date().toISOString();

const productIssues = collectProductIssues();
const playthroughIssues = collectPlaythroughIssues();
const allIssues = dedupeIssues([...productIssues, ...playthroughIssues]);
const devQueueItems = allIssues
  .filter((issue) => issue.status === 'FAIL')
  .map((issue) => devQueueItemFromIssue(issue, issue.source_pointer));
const qaQueueItems = allIssues.filter((issue) => QA_QUEUE_STATUSES.includes(issue.status));
const regressionLock = buildRegressionLock(allIssues, devQueueItems);

await writeJson(devQueuePath, {
  generated_at: now,
  report_dir: reportDir,
  sources: {
    product_review: productReviewPath,
    playthrough_review: playthroughReviewPath,
    fixed_rules: fixedRulesPath,
    regression_lock: regressionLockPath,
  },
  contract:
    'items에는 status=FAIL이며 recommended_fix/pass_condition/source_pointer가 있는 개발 티켓만 들어간다. 증거 부족, 룰 무효, 범위 제외 항목은 qa_queue로 분리한다.',
  items: devQueueItems,
  qa_queue: qaQueueItems,
  qa_boost_required: qaQueueItems,
});

await writeJson(regressionLockPath, regressionLock);

console.log(
  `dev queue built: ${devQueueItems.length} item(s), ${qaQueueItems.length} QA queue item(s), ${regressionLock.screens.length} regression lock screen(s)`,
);

function collectProductIssues() {
  const issues = [];
  for (const screen of productReview.screens ?? []) {
    const targetId = screen.id;
    const screenshot = screenshotBasename(screen.screenshot);
    const sourcePointerPrefix = `product_review:${targetId}`;
    if (Array.isArray(screen.qa_issues) && screen.qa_issues.length > 0) {
      for (const issue of screen.qa_issues) {
        issues.push(normalizeQaIssue(issue, {
          source: 'product_review',
          target_type: 'screen',
          target_id: targetId,
          screenshot,
          source_pointer: issueSourcePointer(sourcePointerPrefix, targetId, issue.id),
        }));
      }
    } else if (Array.isArray(screen.findings) && screen.findings.length > 0) {
      for (const finding of screen.findings.filter((item) => item.rule_id)) {
        const rule = fixedRules.find((item) => item.rule_id === finding.rule_id) ?? finding;
        issues.push(issueFromFixedRule(rule, {
          source: 'product_review',
          targetType: 'screen',
          targetId,
          screenshot,
          sourcePointer: issueSourcePointer(sourcePointerPrefix, targetId, `${targetId}.${finding.rule_id}`),
        }));
      }
    } else if (screen.status === 'blocked') {
      issues.push(blockedIssue({
        id: `${targetId}.qa_evidence_incomplete`,
        source: 'product_review',
        targetType: 'screen',
        targetId,
        screenshot,
        observed: `${screenshot} 화면은 fixed rule finding이 없어 개발 큐로 확정할 수 있는 직접 결함 근거가 부족하다.`,
        sourcePointer: issueSourcePointer(sourcePointerPrefix, targetId, `${targetId}.qa_evidence_incomplete`),
      }));
    }
  }
  for (const finding of productReview.global_visual_findings ?? []) {
    const rule = fixedRules.find((item) => item.rule_id === finding.rule_id) ?? finding;
    issues.push(issueFromFixedRule(rule, {
      source: 'product_review',
      targetType: targetTypeForRule(rule),
      targetId: rule.target_id ?? finding.target_id,
      screenshot: null,
      sourcePointer: issueSourcePointer('product_review:global', rule.target_id ?? finding.target_id, `${rule.target_id}.${rule.rule_id}`),
    }));
  }
  return normalizeIssues(issues);
}

function collectPlaythroughIssues() {
  const issues = [];
  for (const flow of playthroughReview.flows ?? []) {
    const targetId = flow.flow_id;
    const sourcePointerPrefix = `playthrough_review:${targetId}`;
    if (Array.isArray(flow.qa_issues) && flow.qa_issues.length > 0) {
      for (const issue of flow.qa_issues) {
        issues.push(normalizeQaIssue(issue, {
          source: 'playthrough_review',
          target_type: 'flow',
          target_id: targetId,
          source_pointer: issueSourcePointer(sourcePointerPrefix, targetId, issue.id),
        }));
      }
    } else if (Array.isArray(flow.findings) && flow.findings.length > 0) {
      for (const finding of flow.findings.filter((item) => item.rule_id)) {
        const rule = fixedRules.find((item) => item.rule_id === finding.rule_id) ?? finding;
        issues.push(issueFromFixedRule(rule, {
          source: 'playthrough_review',
          targetType: 'flow',
          targetId,
          sourcePointer: issueSourcePointer(sourcePointerPrefix, targetId, `${targetId}.${finding.rule_id}`),
        }));
      }
    } else if (flow.verdict === 'blocked') {
      issues.push(blockedIssue({
        id: `${targetId}.qa_evidence_incomplete`,
        source: 'playthrough_review',
        targetType: 'flow',
        targetId,
        observed: `${flow.title ?? targetId} 흐름은 fixed rule finding과 실제 한국어 transcript 근거가 부족해 PASS/FAIL을 단정할 수 없다.`,
        missingEvidence: ['실제 한국어 transcript', 'CTA/선택/결과 연결 근거', 'fixed rule finding 여부'],
        blockedReason: '플레이 경험 문제를 개발 티켓으로 확정할 직접 흐름 증거가 부족하다.',
        sourcePointer: issueSourcePointer(sourcePointerPrefix, targetId, `${targetId}.qa_evidence_incomplete`),
      }));
    }
  }
  return normalizeIssues(issues);
}

function buildRegressionLock(issues, queueItems) {
  const queueIds = new Set(queueItems.map((item) => item.id));
  const screenById = new Map((matrix.screens ?? []).map((screen) => [screen.id, screen]));
  const issuesByTarget = new Map();
  for (const issue of issues.filter((item) => item.target_type === 'screen' && REGRESSION_LOCK_SCREEN_IDS.includes(item.target_id))) {
    const list = issuesByTarget.get(issue.target_id) ?? [];
    list.push(issue);
    issuesByTarget.set(issue.target_id, list);
  }
  const screens = REGRESSION_LOCK_SCREEN_IDS.map((screenId) => {
    const screen = screenById.get(screenId);
    const targetIssues = dedupeIssues(issuesByTarget.get(screenId) ?? []);
    const checks = targetIssues.map((issue) => ({
      id: issue.rule_id ?? issue.id,
      issue_id: issue.id,
      status: issue.status,
      severity: issue.severity,
      evidence: issue.evidence?.observed ?? '',
      pass_condition: issue.pass_condition,
      dev_queue_item_id: queueIds.has(issue.id) ? issue.id : null,
    }));
    for (const rule of fixedRules.filter((item) => item.type === 'screen_problem' && item.target_id === screenId)) {
      if (checks.some((check) => check.id === rule.rule_id)) continue;
      checks.push({
        id: rule.rule_id,
        issue_id: `${screenId}.${rule.rule_id}.pass`,
        status: 'PASS',
        severity: rule.severity ?? 'P3',
        evidence: `${screen?.screenshot ?? screenId} review qa_issues에서 ${rule.rule_id} FAIL finding이 검출되지 않았다.`,
        pass_condition: rule.pass_criteria ?? `${rule.rule_id} finding이 없어야 한다.`,
        dev_queue_item_id: null,
      });
    }
    const status = checks.some((check) => check.status === 'FAIL')
      ? 'FAIL'
      : checks.some((check) => check.status === 'BLOCKED')
        ? 'BLOCKED'
        : checks.some((check) => check.status === 'RULE_INVALID')
          ? 'RULE_INVALID'
        : 'PASS';
    return {
      id: screenId,
      screen: screen?.screen ?? screenId,
      status,
      screenshot: screen?.screenshot ?? null,
      checks,
      dev_queue_item_ids: checks.map((check) => check.dev_queue_item_id).filter(Boolean),
    };
  });
  return {
    generated_at: now,
    report_dir: reportDir,
    required_screens: REGRESSION_LOCK_SCREEN_IDS,
    required_base_status_rule_ids: REQUIRED_BASE_STATUS_RULE_IDS,
    screens,
  };
}

function screenshotBasename(value) {
  const text = String(value ?? '').trim();
  return text.split('/').filter(Boolean).at(-1) ?? text;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
