#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { readJson } from './qa_lib.mjs';

const matrixPath = process.env.QA_MATRIX_PATH ?? 'tools/qa_matrix.json';
const playthroughMatrixPath =
  process.env.QA_PLAYTHROUGH_MATRIX_PATH ?? 'tools/qa_playthrough_matrix.json';
const changedFiles = await parseChangedFiles();
const matrix = await readJson(matrixPath);
const playthroughMatrix = await readJson(playthroughMatrixPath);

const plan = buildPlan(changedFiles);
const outputPath = process.env.QA_PLAN_OUTPUT_PATH;
if (outputPath) {
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
}

console.log(JSON.stringify(plan, null, 2));

async function parseChangedFiles() {
  if (process.env.QA_CHANGED_FILES) {
    return process.env.QA_CHANGED_FILES.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
  }
  const argIndex = process.argv.indexOf('--changed-files');
  if (argIndex >= 0 && process.argv[argIndex + 1]) {
    return process.argv[argIndex + 1].split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
  }
  const fileArgIndex = process.argv.indexOf('--changed-files-path');
  if (fileArgIndex >= 0 && process.argv[fileArgIndex + 1]) {
    const content = await readFile(process.argv[fileArgIndex + 1], 'utf8');
    return content.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  }
  return [];
}

function buildPlan(files) {
  const groups = new Set();
  const reasons = [];
  let mode = 'fast';

  if (files.length === 0) {
    mode = 'full';
    reasons.push('변경 파일 목록이 없어 영향 범위를 좁힐 수 없습니다.');
  }

  for (const file of files) {
    const normalized = file.replaceAll('\\', '/');
    const match = ruleFor(normalized);
    if (match.full) {
      mode = 'full';
    }
    for (const group of match.groups) groups.add(group);
    reasons.push(`${normalized}: ${match.reason}`);
  }

  if (mode === 'full') {
    for (const screen of matrix.screens ?? []) groups.add(screen.fastQaGroup ?? 'misc');
  }

  if (groups.size === 0) {
    groups.add('base');
    groups.add('event');
    reasons.push('명확한 규칙이 없어 기본 high-risk 화면을 검수합니다.');
  }

  const screenIds = (matrix.screens ?? [])
    .filter((screen) => mode === 'full' || groups.has(screen.fastQaGroup))
    .map((screen) => screen.id);
  const playthroughIds = (playthroughMatrix.flows ?? [])
    .filter((flow) => mode === 'full' || groups.has(flow.fastQaGroup) || flow.fastQaGroup === 'regression')
    .map((flow) => flow.id);

  return {
    generated_at: new Date().toISOString(),
    mode,
    final_pass_allowed: mode === 'full',
    changed_files: files,
    qa_groups: [...groups].sort(),
    screens: screenIds,
    playthroughs: playthroughIds,
    commands: {
      capture:
        mode === 'full'
          ? 'node tools/qa_capture_chrome.mjs'
          : `QA_GROUP=${[...groups].sort().join(',')} node tools/qa_capture_chrome.mjs`,
      validate:
        mode === 'full'
          ? 'QA_MODE=full QA_EXPECT_FINAL_STATUS=pass node tools/qa_validate_report.mjs'
          : 'QA_MODE=fast QA_EXPECT_FINAL_STATUS=not_pass node tools/qa_validate_report.mjs',
    },
    reasons,
  };
}

function ruleFor(file) {
  if (file.includes('dragon_work')) {
    return {
      groups: ['dragon_work'],
      full: false,
      reason: 'Dragon Work 구현/asset 변경: Dragon Work 전용 화면 fast QA',
    };
  }
  if (file.startsWith('tools/qa_') || file.startsWith('docs/qa/')) {
    return {
      groups: ['base'],
      full: false,
      reason: 'QA 도구/문서 변경: tool tests와 sample report 검증 우선',
    };
  }
  if (file.includes('theme') || file.includes('hud') || file.includes('screen_frame') || file.includes('common')) {
    return {
      groups: ['base', 'base_dialog', 'event', 'report', 'ending'],
      full: false,
      reason: '공통 UI 표면 변경: high-risk 화면 fast QA',
    };
  }
  if (file.includes('l10n') || file.includes('copy') || file.includes('content') || file.includes('event_card') || file.endsWith('CONTENT.md')) {
    return {
      groups: ['report', 'event', 'archive', 'ending', 'regression'],
      full: false,
      reason: '문구/이벤트 데이터 변경: report/event/archive/ending playthrough QA',
    };
  }
  if (file.includes('ending') || file.includes('guardian') || file.includes('event_service')) {
    return {
      groups: ['base_dialog', 'event', 'ending', 'regression'],
      full: false,
      reason: '엔딩/가디언/이벤트 서비스 변경: ending cycle과 회귀 흐름 QA',
    };
  }
  if (file.startsWith('lib/') || file.startsWith('assets/')) {
    return {
      groups: ['base', 'report', 'event', 'regression'],
      full: false,
      reason: '앱 구현 변경: 주요 제품 흐름 fast QA',
    };
  }
  return {
    groups: ['base', 'event', 'regression'],
    full: true,
    reason: '영향 범위가 불명확해 Full QA로 승격',
  };
}
