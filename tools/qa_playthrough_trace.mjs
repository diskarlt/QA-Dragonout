#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const reportDir = resolve(
  process.env.QA_REPORT_DIR ?? 'docs/qa/reports/2026-05-09-ui-qa-pipeline',
);
const matrixPath = process.env.QA_MATRIX_PATH ?? 'tools/qa_matrix.json';
const playthroughMatrixPath =
  process.env.QA_PLAYTHROUGH_MATRIX_PATH ?? 'tools/qa_playthrough_matrix.json';
const screenArtifactsDir = process.env.QA_SCREEN_ARTIFACTS_DIR ?? join(reportDir, 'screen_artifacts');
const playthroughTraceDir = join(reportDir, 'playthrough_trace');
const playthroughTracePath =
  process.env.QA_PLAYTHROUGH_TRACE_PATH ?? join(reportDir, 'playthrough_trace.json');

const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
const playthroughMatrix = JSON.parse(await readFile(playthroughMatrixPath, 'utf8'));

const screenById = new Map((matrix.screens ?? []).map(s => [s.id, s]));

await mkdir(playthroughTraceDir, { recursive: true });

const flows = [];
for (const flow of playthroughMatrix.flows ?? []) {
  const flowTrace = await buildFlowTrace(flow);
  flows.push(flowTrace);
  await writeJson(join(playthroughTraceDir, `${flow.id}.json`), flowTrace);
  console.log(`${flow.id} -> ${flowTrace.status} (${flowTrace.steps.length} steps)`);
}

const aggregate = {
  version: 1,
  generated_at: new Date().toISOString(),
  flows,
};
await writeJson(playthroughTracePath, aggregate);
console.log(`playthrough_trace.json written: ${flows.length} flows`);

async function buildFlowTrace(flow) {
  const stepArtifacts = await Promise.all(
    (flow.steps ?? []).map(screenId => readArtifact(screenId)),
  );

  const steps = (flow.steps ?? []).map((screenId, index) => {
    const artifact = stepArtifacts[index];
    const screen = screenById.get(screenId);
    const nextScreen = screenById.get(flow.steps[index + 1]);
    const nextArtifact = stepArtifacts[index + 1] ?? null;

    const primaryCta = artifact
      ? (artifact.primaryCtas ?? []).find(c => c.enabled !== false) ?? null
      : null;
    const secondaryCtas = artifact
      ? (artifact.primaryCtas ?? []).filter(c => c.enabled !== false && c !== primaryCta)
      : [];
    const disabledChoices = artifact
      ? (artifact.primaryCtas ?? []).filter(c => c.enabled === false)
      : [];

    const action = {
      type: 'navigate',
      label: primaryCta?.label ?? null,
      target: nextScreen?.id ?? null,
      enabled: !!primaryCta,
      bounds: primaryCta?.bounds ?? null,
      resultStage: nextScreen?.state ?? null,
      resultScreen: nextScreen?.id ?? null,
    };

    return {
      step_id: `${flow.id}.${index}`,
      screen: screenId,
      stage: screen?.state ?? null,
      visibleText: artifact?.visibleText ?? [],
      primaryCta: primaryCta ?? null,
      secondaryCtas,
      selectedChoice: null,
      disabledChoices,
      action,
      beforeGameState: artifact?.gameState ?? null,
      afterGameState: nextArtifact?.gameState ?? null,
      screenshot: artifact?.screenshot ?? screen?.screenshot ?? null,
      timestamp: null,
    };
  });

  const allText = steps.flatMap(s => s.visibleText ?? []);
  const normalizedText = deduplicateText(allText);

  const actionTrace = steps.map(s => s.action).filter(a => a.label || a.target);

  const missingEvidence = [];
  const stepsWithoutText = steps.filter(s => (s.visibleText ?? []).length === 0);
  if (stepsWithoutText.length > 0) {
    for (const s of stepsWithoutText) {
      missingEvidence.push(`${s.screen}: visibleText 없음 — screen_artifacts 미생성 또는 canvas 렌더링`);
    }
  }
  const stepsWithoutGameState = steps.filter(s => s.beforeGameState === null);
  if (stepsWithoutGameState.length > 0) {
    missingEvidence.push('gameState null — window.__QA_SNAPSHOT__ 앱 측 미구현');
  }

  const stepsWithText = steps.filter(s => (s.visibleText ?? []).length > 0);
  const status =
    stepsWithText.length === 0
      ? 'failed'
      : stepsWithText.length < steps.length
        ? 'partial'
        : 'captured';

  return {
    flow_id: flow.id,
    status,
    steps,
    normalizedText,
    actionTrace,
    missingEvidence,
    sourceScreens: flow.steps ?? [],
  };
}

async function readArtifact(screenId) {
  try {
    const text = await readFile(join(screenArtifactsDir, `${screenId}.json`), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function deduplicateText(lines) {
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    const normalized = line.replace(/\s+/g, ' ').trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
