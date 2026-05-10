#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
import { analyzePngImage, readJson, readPng } from './qa_lib.mjs';

const matrixPath = process.env.QA_MATRIX_PATH ?? 'tools/qa_matrix.json';
const screenshotDir =
  process.env.QA_SCREENSHOT_DIR ??
  'docs/qa/reports/2026-05-09-ui-qa-pipeline/screenshots';
const outputPath =
  process.env.QA_POLISH_LINTS_PATH ?? join(dirname(screenshotDir), 'polish_lints.json');
const matrix = await readJson(matrixPath);
const expectedWidth = matrix.viewport?.width ?? 390;
const expectedHeight = matrix.viewport?.height ?? 844;
const results = [];

for (const screen of matrix.screens) {
  const path = join(screenshotDir, screen.screenshot);
  const findings = [];
  let metrics = null;
  let status = 'pass';
  try {
    const fileStat = await stat(path);
    if (fileStat.size < 2500) {
      findings.push(finding('P0', 'capture_too_small', '캡처 파일이 비정상적으로 작습니다.'));
    }
    const image = await readPng(path);
    metrics = analyzePngImage(image);
    if (image.width !== expectedWidth || image.height !== expectedHeight) {
      findings.push(
        finding(
          'P0',
          'dimension_mismatch',
          `캡처 크기가 ${image.width}x${image.height}이며 기대값 ${expectedWidth}x${expectedHeight}와 다릅니다.`,
        ),
      );
    }
    if (metrics.contrast_range < 18) {
      findings.push(finding('P0', 'blank_or_flat_capture', '화면 대비가 거의 없어 빈 화면일 가능성이 큽니다.'));
    } else if (metrics.contrast_range < 32) {
      findings.push(finding('P1', 'low_contrast', '상업용 UI 기준으로 화면 대비가 낮아 보일 수 있습니다.'));
    } else if (metrics.contrast_range < 42) {
      findings.push(finding('P3', 'dark_hud_contrast_review', '다크 HUD 톤의 대비를 Codex 제품 검수에서 재확인해야 합니다.'));
    }
    if (metrics.white_ratio > 0.42 || metrics.black_ratio > 0.92) {
      findings.push(finding('P0', 'blank_screen_ratio', '흰 화면 또는 검은 화면 비율이 비정상적으로 큽니다.'));
    }
    if (metrics.largest_bright_block_ratio > 0.045) {
      findings.push(finding('P1', 'large_white_block', '큰 흰색/저채도 사각형 후보가 감지됐습니다.'));
    } else if (metrics.largest_bright_block_ratio > 0.022) {
      findings.push(finding('P2', 'bright_badge_candidate', '작은 흰색 배지 또는 비트맵 배경 후보가 있습니다.'));
    }
    if (metrics.bright_low_saturation_ratio > 0.12) {
      findings.push(finding('P2', 'bright_low_saturation_noise', '밝은 저채도 영역이 많아 UI 톤 불일치 후보입니다.'));
    }
    if (metrics.edge_noise > 0.185 && metrics.average_saturation < 0.24) {
      findings.push(finding('P2', 'muddy_dense_texture', '어두운 저채도 텍스처와 엣지가 많아 화면이 탁해 보일 수 있습니다.'));
    } else if (metrics.edge_noise > 0.205) {
      findings.push(finding('P3', 'high_visual_density', '텍스처/장식 밀도가 높아 상업용 polish 검수에서 확인이 필요합니다.'));
    }
  } catch (error) {
    findings.push(
      finding(
        'P0',
        'capture_read_failed',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  if (findings.some((item) => ['P0', 'P1', 'P2'].includes(item.severity))) {
    status = 'fail';
  }

  results.push({
    id: screen.id,
    screen: screen.screen,
    state: screen.state,
    screenshot: screen.screenshot,
    status,
    metrics,
    findings,
  });
}

const summary = {
  pass: results.filter((result) => result.status === 'pass').length,
  low_confidence: results.filter((result) => result.status === 'low_confidence').length,
  fail: results.filter((result) => result.status === 'fail').length,
};

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      matrix: matrixPath,
      screenshot_dir: screenshotDir,
      summary,
      results,
    },
    null,
    2,
  )}\n`,
);

if (summary.fail > 0) {
  console.error(`polish lint failed before Codex product review: ${summary.fail} screen(s)`);
  process.exit(1);
}

console.log(`polish lint complete: ${summary.pass} pass, ${summary.low_confidence} low confidence`);

function finding(severity, code, message) {
  return { severity, code, message };
}
