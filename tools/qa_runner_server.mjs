#!/usr/bin/env node

import { createServer } from 'node:http';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const runnerRoot = resolve(process.cwd());
const canonicalRunnerRoot = resolve(process.env.QA_CANONICAL_RUNNER_ROOT ?? '/Users/euna/Developer/QA-Dragonout');
const defaultTarget = process.env.QA_TARGET_WORKTREE ?? '/Users/euna/Developer/Dragonout';
const defaultReportDir = resolve(process.env.QA_REPORT_DIR ?? join(runnerRoot, 'reports/current'));
const defaultScreenshotDir = resolve(process.env.QA_SCREENSHOT_DIR ?? join(defaultReportDir, 'screenshots'));
const qaMatrixPath = resolve(process.env.QA_MATRIX_PATH ?? join(runnerRoot, 'tools/qa_matrix.json'));
const qaPlaythroughMatrixPath = resolve(process.env.QA_PLAYTHROUGH_MATRIX_PATH ?? join(runnerRoot, 'tools/qa_playthrough_matrix.json'));
const host = process.env.QA_DASHBOARD_HOST ?? '127.0.0.1';
const port = Number(process.env.QA_DASHBOARD_PORT ?? 64700);
const testMode = process.env.QA_RUNNER_TEST_MODE === '1';
const testDelayMs = Number(process.env.QA_RUNNER_TEST_DELAY_MS ?? 0);
const allowedRoot = '/Users/euna/Developer';
const dashboardVersion = 'calibration-readability-v1';
const serverStartedAt = new Date().toISOString();
let currentReportDir = defaultReportDir;
let currentScreenshotDir = defaultScreenshotDir;
let activeJob = null;
let lastJob = null;
let jobCounter = 0;
let server = null;

await ensureReportSeed();

server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    writeJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`Dragonout QA Dashboard: http://${host}:${port}`);
  console.log(`Report dir: ${currentReportDir}`);
});

async function route(request, response) {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);
  if (request.method === 'GET' && url.pathname === '/') {
    return writeHtml(response, dashboardHtml());
  }
  if (request.method === 'GET' && url.pathname === '/report') {
    return serveFile(response, join(currentReportDir, 'report.html'));
  }
  if (request.method === 'GET' && url.pathname === '/calibration') {
    return serveFile(response, join(currentReportDir, 'calibration.html'));
  }
  if (request.method === 'GET' && url.pathname.startsWith('/screenshots/')) {
    return serveReportRelative(response, currentScreenshotDir, url.pathname, '/screenshots/');
  }
  if (request.method === 'GET' && url.pathname === '/api/status') {
    return writeJson(response, 200, await statusPayload());
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return writeJson(response, 200, serverIdentity());
  }
  if (request.method === 'GET' && url.pathname === '/api/reports/current') {
    return writeJson(response, 200, await reportPayload());
  }
  if (request.method === 'GET' && url.pathname === '/api/report-view') {
    return writeJson(response, 200, await reportViewPayload());
  }
  if (request.method === 'GET' && url.pathname === '/api/calibration-profile') {
    return writeJson(response, 200, await calibrationProfilePayload());
  }
  if (request.method === 'POST' && url.pathname === '/api/calibration-profile') {
    return saveCalibrationProfile(request, response);
  }
  if (request.method === 'POST' && url.pathname === '/api/run/fast') {
    return startJobFromRequest(request, response, 'fast');
  }
  if (request.method === 'POST' && url.pathname === '/api/run/full') {
    return startJobFromRequest(request, response, 'full');
  }
  if (request.method === 'POST' && url.pathname === '/api/refresh-report') {
    return startJobFromRequest(request, response, 'refresh');
  }
  if (request.method === 'POST' && url.pathname === '/api/cancel') {
    return cancelJob(response);
  }
  if (request.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
    return serveReportRelative(response, currentReportDir, url.pathname, '/artifacts/');
  }
  if (request.method === 'GET' && url.pathname.startsWith('/report-assets/')) {
    return serveReportRelative(response, currentReportDir, url.pathname, '/report-assets/');
  }
  writeJson(response, 404, { error: 'not found' });
}

async function startJobFromRequest(request, response, mode) {
  const body = await readRequestJson(request);
  if (activeJob) {
    return writeJson(response, 409, {
      error: '이미 실행 중인 QA job이 있습니다.',
      job: publicJob(activeJob),
    });
  }
  let targetWorktree;
  try {
    targetWorktree = validateTarget(body.targetWorktree || defaultTarget);
  } catch (error) {
    return writeJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let jobReportDir;
  let jobScreenshotDir;
  try {
    jobReportDir = validateReportDir(body.reportDir || currentReportDir);
    jobScreenshotDir = validateReportDir(body.screenshotDir || join(jobReportDir, 'screenshots'));
  } catch (error) {
    return writeJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  currentReportDir = jobReportDir;
  currentScreenshotDir = jobScreenshotDir;
  const changedFiles = splitLines(body.changedFiles ?? '');
  activeJob = {
    id: `qa-${++jobCounter}`,
    mode,
    targetWorktree,
    reportDir: jobReportDir,
    screenshotDir: jobScreenshotDir,
    changedFiles,
    status: 'queued',
    phase: 'queued',
    message: '대기 중',
    startedAt: new Date().toISOString(),
    current: 0,
    total: mode === 'refresh' ? 3 : mode === 'fast' ? 7 : 10,
    events: [],
    children: [],
    cancelled: false,
    automatedGate: 'not_started',
    codexReview: 'not_entered',
    finalStatus: 'not_started',
    nextAction: 'QA 실행 대기',
  };
  lastJob = activeJob;
  writeJson(response, 202, { job: publicJob(activeJob) });
  runJob(activeJob).catch(async (error) => {
    await markJob(activeJob, 'failed', activeJob.phase, error instanceof Error ? error.message : String(error));
    activeJob = null;
  });
}

async function runJob(job) {
  await markJob(job, 'running', 'queued', `${job.mode} QA job 시작`);
  try {
    if (job.mode === 'refresh') {
      await refreshReport(job, 'Report만 갱신');
      await markJob(job, 'complete', 'complete', 'Report 갱신 완료', job.total, job.total);
      activeJob = null;
      return;
    }
    await resetReportForRun(job);
    await runProcessStep(job, 'analyzing changes', '변경 영향 범위 계산', process.execPath, ['tools/qa_plan_run.mjs'], {
      cwd: runnerRoot,
      env: {
        ...process.env,
        QA_CHANGED_FILES: job.changedFiles.join('\n'),
        QA_PLAN_OUTPUT_PATH: join(job.reportDir, 'qa_plan_result.json'),
      },
    });
    if (testMode) {
      await markJob(job, 'running', 'test-mode', '테스트 모드: 무거운 Flutter/Chrome 단계는 시뮬레이션합니다.', 2, job.total);
      if (testDelayMs > 0) await sleep(testDelayMs);
      if (job.cancelled) throw new Error('cancelled');
      await refreshReport(job, '테스트 모드 report 갱신');
      if (job.cancelled) throw new Error('cancelled');
      await markJob(job, 'complete', 'complete', '테스트 모드 QA 완료', job.total, job.total);
      activeJob = null;
      return;
    }
    await runProcessStep(job, 'tests', 'flutter analyze', 'flutter', ['analyze'], { cwd: job.targetWorktree });
    await runProcessStep(job, 'tests', 'flutter test', 'flutter', ['test'], { cwd: job.targetWorktree });
    if (job.mode === 'full') {
      await runProcessStep(job, 'build', 'flutter build web --debug', 'flutter', ['build', 'web', '--debug'], { cwd: job.targetWorktree });
    }
    await runCapturePipeline(job);
    await buildDevQueue(job, { requireReviews: true });
    const gateSummary = await qaGateSummary(job);
    job.automatedGate = gateSummary.automatedGate;
    job.codexReview = gateSummary.codexReview;
    job.finalStatus = gateSummary.finalStatus;
    job.nextAction = gateSummary.nextAction;
    await refreshReport(job, 'QA HTML report 생성');
    const expectedFinalStatus =
      job.mode === 'full' && job.finalStatus === 'pass' ? 'pass' : 'not_pass';
    await runProcessStep(job, 'validation', 'artifact validation', process.execPath, ['tools/qa_validate_report.mjs'], {
      cwd: runnerRoot,
      env: {
        ...process.env,
        QA_MODE: job.mode,
        QA_EXPECT_FINAL_STATUS: expectedFinalStatus,
        QA_REPORT_DIR: job.reportDir,
        QA_SCREENSHOT_DIR: job.screenshotDir,
        QA_DEV_QUEUE_PATH: join(job.reportDir, 'dev_queue.json'),
        QA_REGRESSION_LOCK_PATH: join(job.reportDir, 'regression_lock.json'),
        QA_LIVE_STATUS_PATH: join(job.reportDir, 'qa_live_status.json'),
        QA_HTML_REPORT_PATH: join(job.reportDir, 'report.html'),
        QA_MARKDOWN_REPORT_PATH: join(job.reportDir, 'report.md'),
        QA_CALIBRATION_HTML_PATH: join(job.reportDir, 'calibration.html'),
        QA_CAPTURE_RESULT_PATH: join(job.reportDir, 'capture_result.json'),
        QA_POLISH_LINTS_PATH: join(job.reportDir, 'polish_lints.json'),
        QA_PRODUCT_REVIEW_PATH: join(job.reportDir, 'codex_product_review.json'),
        QA_PLAYTHROUGH_REVIEW_PATH: join(job.reportDir, 'codex_playthrough_review.json'),
        QA_SCREEN_ARTIFACTS_PATH: join(job.reportDir, 'screen_artifacts.json'),
      },
    });
    await markJob(job, 'complete', 'complete', `${job.mode} QA 완료`, job.total, job.total);
  } catch (error) {
    job.finalStatus = job.cancelled ? 'cancelled' : 'failed';
    job.nextAction = nextActionForFailure(job.phase);
    if (job.cancelled) {
      await markJob(job, 'cancelled', 'cancelled', '사용자가 QA job을 취소했습니다.');
    } else {
      await markJob(job, 'failed', job.phase, error instanceof Error ? error.message : String(error));
      await refreshReportAfterFailure(job);
    }
  } finally {
    activeJob = null;
  }
}

async function runCapturePipeline(job) {
  await mkdir(job.screenshotDir, { recursive: true });
  await runProcessStep(job, 'build', 'target web server 시작', process.execPath, [
    '-e',
    serverSnippet(job.targetWorktree),
  ], {
    cwd: job.targetWorktree,
    detached: true,
    keepChild: true,
  });
  const serverChild = job.children.at(-1);
  try {
    await sleep(1200);
    await runProcessStep(job, 'capture', 'Chrome screenshot capture', process.execPath, ['tools/qa_capture_chrome.mjs'], {
      cwd: runnerRoot,
      env: {
        ...process.env,
        QA_MODE: job.mode,
        QA_GROUP: job.mode === 'fast' ? 'base,event,regression' : '',
        QA_BASE_URL: 'http://127.0.0.1:64618',
        QA_REPORT_DIR: job.reportDir,
        QA_SCREENSHOT_DIR: job.screenshotDir,
        QA_LIVE_STATUS_PATH: join(job.reportDir, 'qa_live_status.json'),
        QA_LIVE_REPORT: '1',
      },
    });
    await runNonBlockingLintStep(job);
    await runProcessStep(job, 'codex review', '현재 캡처 기반 제품/흐름 review 작성', process.execPath, ['tools/qa_write_current_reviews.mjs'], {
      cwd: runnerRoot,
      env: {
        ...process.env,
        QA_REPORT_DIR: job.reportDir,
        QA_SCREENSHOT_DIR: job.screenshotDir,
        QA_POLISH_LINTS_PATH: join(job.reportDir, 'polish_lints.json'),
        QA_PRODUCT_REVIEW_PATH: join(job.reportDir, 'codex_product_review.json'),
        QA_PLAYTHROUGH_REVIEW_PATH: join(job.reportDir, 'codex_playthrough_review.json'),
      },
    });
  } finally {
    serverChild?.kill('SIGTERM');
  }
}

async function runNonBlockingLintStep(job) {
  if (job.cancelled) throw new Error('cancelled');
  await markJob(job, 'running', 'lint', 'polish lint', Math.min(job.current + 1, job.total), job.total);
  try {
    await runCommand(process.execPath, ['tools/qa_polish_lints.mjs'], {
      cwd: runnerRoot,
      env: {
        ...process.env,
        QA_REPORT_DIR: job.reportDir,
        QA_SCREENSHOT_DIR: job.screenshotDir,
        QA_POLISH_LINTS_PATH: join(job.reportDir, 'polish_lints.json'),
      },
    });
    job.lastError = null;
  } catch (error) {
    job.automatedGate = 'fail';
    job.lastError = trimOutput(error instanceof Error ? error.message : String(error));
    job.nextAction = '자동 lint FAIL 화면도 기록하되, 현재 캡처 기반 제품/흐름 review를 계속 작성합니다.';
  }
}

async function qaGateSummary(job) {
  const lints = await readJsonIfExists(join(job.reportDir, 'polish_lints.json'));
  const productReview = await readJsonIfExists(join(job.reportDir, 'codex_product_review.json'));
  const playthroughReview = await readJsonIfExists(join(job.reportDir, 'codex_playthrough_review.json'));
  const lintFail = Number(lints?.summary?.fail ?? 0) > 0;
  const productFail = productReview?.status !== 'pass';
  const playthroughFail = playthroughReview?.status !== 'pass';
  if (lintFail || productFail || playthroughFail) {
    return {
      automatedGate: lintFail ? 'fail' : 'pass',
      codexReview: productFail || playthroughFail ? 'fail' : 'ready',
      finalStatus: 'qa_failed',
      nextAction: '현재 캡처 기반 수정 큐를 확인하고, 구체 FAIL 항목만 개발 대상으로 확정하세요.',
    };
  }
  return {
    automatedGate: 'pass',
    codexReview: 'ready',
    finalStatus: job.mode === 'full' ? 'pass' : 'partial_complete',
    nextAction: job.mode === 'full'
      ? '강화된 QA 허들 기준으로 최종 PASS 검증을 진행했습니다.'
      : '부분 검수 결과를 확인하세요.',
  };
}

async function refreshReport(job, message, options = {}) {
  await buildDevQueue(job, options);
  await runProcessStep(job, 'report generation', message, process.execPath, ['tools/qa_generate_html_report.mjs'], {
    cwd: runnerRoot,
    env: {
      ...process.env,
      QA_REPORT_DIR: job.reportDir,
      QA_SCREENSHOT_DIR: job.screenshotDir,
      QA_LIVE_STATUS_PATH: join(job.reportDir, 'qa_live_status.json'),
      QA_MODE: job.mode,
    },
  });
}

async function refreshReportAfterFailure(job) {
  try {
    await runDevQueueCommand(job);
    await runCommand(
      process.execPath,
      ['tools/qa_generate_html_report.mjs'],
      {
        cwd: runnerRoot,
        env: {
          ...process.env,
          QA_REPORT_DIR: job.reportDir,
          QA_SCREENSHOT_DIR: job.screenshotDir,
          QA_LIVE_STATUS_PATH: join(job.reportDir, 'qa_live_status.json'),
          QA_MODE: job.mode,
        },
      },
    );
  } catch (error) {
    job.lastError = trimOutput(`${job.lastError ?? ''}\nReport refresh after failure failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function buildDevQueue(job, options = {}) {
  const productReview = await readJsonIfExists(join(job.reportDir, 'codex_product_review.json'));
  const playthroughReview = await readJsonIfExists(join(job.reportDir, 'codex_playthrough_review.json'));
  const missingReviewFiles = [];
  if (!productReview) missingReviewFiles.push(join(job.reportDir, 'codex_product_review.json'));
  if (!playthroughReview) missingReviewFiles.push(join(job.reportDir, 'codex_playthrough_review.json'));
  if (missingReviewFiles.length > 0) {
    if (!options.requireReviews) return false;
    throw new Error(`dev_queue/regression_lock 생성 불가: review 산출물이 없습니다 (${missingReviewFiles.join(', ')})`);
  }
  await runDevQueueCommand(job, true);
  return true;
}

async function runDevQueueCommand(job, asProcessStep = false) {
  const options = {
    cwd: runnerRoot,
    env: {
      ...process.env,
      QA_REPORT_DIR: job.reportDir,
      QA_SCREENSHOT_DIR: job.screenshotDir,
      QA_PRODUCT_REVIEW_PATH: join(job.reportDir, 'codex_product_review.json'),
      QA_PLAYTHROUGH_REVIEW_PATH: join(job.reportDir, 'codex_playthrough_review.json'),
      QA_DEV_QUEUE_PATH: join(job.reportDir, 'dev_queue.json'),
      QA_REGRESSION_LOCK_PATH: join(job.reportDir, 'regression_lock.json'),
    },
  };
  if (asProcessStep) {
    await runProcessStep(job, 'dev queue', 'dev_queue/regression_lock 생성', process.execPath, ['tools/qa_build_dev_queue.mjs'], options);
    return;
  }
  await runCommand(process.execPath, ['tools/qa_build_dev_queue.mjs'], options);
}

async function runProcessStep(job, phase, message, command, args, options = {}) {
  if (job.cancelled) throw new Error('cancelled');
  await markJob(job, 'running', phase, message, Math.min(job.current + 1, job.total), job.total);
  const child = spawn(command, args, {
    cwd: options.cwd ?? runnerRoot,
    env: options.env ?? process.env,
    detached: options.detached ?? false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  if (options.keepChild) {
    return;
  }
  const code = await new Promise((resolve) => child.on('close', resolve));
  job.children = job.children.filter((item) => item !== child);
  job.lastOutput = trimOutput(stdout);
  if (code !== 0) {
    job.lastError = trimOutput(stderr);
    if (phase === 'lint') {
      job.automatedGate = 'fail';
      job.codexReview = 'not_entered';
      job.nextAction = '자동 검사 FAIL 화면을 수정한 뒤 Fast QA를 다시 실행하세요.';
    }
    throw new Error(`${message} failed (${code}): ${trimOutput(stderr || stdout)}`);
  } else {
    job.lastError = null;
  }
}

async function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? runnerRoot,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) {
    throw new Error(trimOutput(stderr || stdout));
  }
  return { stdout, stderr };
}

async function markJob(job, status, phase, message, current = job.current, total = job.total) {
  job.status = status;
  job.phase = phase;
  job.message = message;
  job.current = current;
  job.total = total;
  const event = { at: new Date().toISOString(), phase, status, message };
  job.events.push(event);
  const screenshotCount = await countScreenshots(job.screenshotDir);
  const finalStatusForReport = job.finalStatus === 'pass' ? 'PASS' : job.finalStatus;
  const liveStatus = {
    status,
    phase,
    message,
    run_id: job.id,
    mode: job.mode,
    targetWorktree: job.targetWorktree,
    reportDir: job.reportDir,
    screenshotDir: job.screenshotDir,
    finalStatus: finalStatusForReport,
    screenshotCount,
    target_worktree: job.targetWorktree,
    report_dir: job.reportDir,
    screenshot_dir: job.screenshotDir,
    started_at: job.startedAt,
    current,
    total,
    automated_gate: job.automatedGate,
    codex_review: job.codexReview,
    final_status: job.finalStatus,
    next_action: job.nextAction,
    last_error: job.lastError ?? null,
    refresh_ms: 1500,
    updated_at: event.at,
    events: job.events.slice(-80),
  };
  await mkdir(job.reportDir, { recursive: true });
  await writeFile(join(job.reportDir, 'qa_live_status.json'), `${JSON.stringify(liveStatus, null, 2)}\n`);
}

async function countScreenshots(screenshotDir) {
  try {
    const entries = await readdir(screenshotDir);
    return entries.filter((entry) => entry.endsWith('.png')).length;
  } catch {
    return 0;
  }
}

async function cancelJob(response) {
  if (!activeJob) return writeJson(response, 200, { cancelled: false, message: '실행 중인 job이 없습니다.' });
  const job = activeJob;
  job.cancelled = true;
  for (const child of job.children) {
    child.kill('SIGTERM');
  }
  await markJob(job, 'cancelled', 'cancelled', '사용자가 QA job을 취소했습니다.');
  writeJson(response, 200, { cancelled: true, job: publicJob(job) });
  activeJob = null;
}

async function statusPayload() {
  return {
    server: serverIdentity(),
    activeJob: activeJob ? publicJob(activeJob) : null,
    lastJob: lastJob ? publicJob(lastJob) : null,
    report: await reportPayload(),
    defaults: {
      targetWorktree: defaultTarget,
      reportDir: currentReportDir,
      screenshotDir: currentScreenshotDir,
      runnerRoot,
      canonicalRunnerRoot,
      dashboardUrl: `http://${host}:${port}`,
    },
  };
}

function serverIdentity() {
  return {
    pid: process.pid,
    runnerRoot,
    canonicalRunnerRoot,
    isCanonicalRunner: runnerRoot === canonicalRunnerRoot,
    reportDir: currentReportDir,
    screenshotDir: currentScreenshotDir,
    dashboardVersion,
    startedAt: serverStartedAt,
    startedAtKst: formatKst(serverStartedAt),
    dashboardUrl: `http://${host}:${port}`,
  };
}

async function reportPayload() {
  const liveStatus = await readJsonIfExists(join(currentReportDir, 'qa_live_status.json'));
  const reportPath = join(currentReportDir, 'report.html');
  let reportStat = null;
  try {
    const fileStat = await stat(reportPath);
    reportStat = { size: fileStat.size, mtime: fileStat.mtime.toISOString() };
  } catch {
    reportStat = null;
  }
  const screenshotStats = await screenshotPayload();
  return {
    reportDir: currentReportDir,
    reportUrl: '/report',
    liveStatus,
    reportStat,
    reportRun: reportRunPayload(liveStatus, reportStat),
    screenshotStats,
  };
}

async function reportViewPayload() {
  const [
    matrix,
    playthroughMatrix,
    capture,
    lints,
    productReview,
    playthroughReview,
    devQueue,
    regressionLock,
    report,
  ] = await Promise.all([
    readJsonIfExists(qaMatrixPath),
    readJsonIfExists(qaPlaythroughMatrixPath),
    readJsonIfExists(join(currentReportDir, 'capture_result.json')),
    readJsonIfExists(join(currentReportDir, 'polish_lints.json')),
    readJsonIfExists(join(currentReportDir, 'codex_product_review.json')),
    readJsonIfExists(join(currentReportDir, 'codex_playthrough_review.json')),
    readJsonIfExists(join(currentReportDir, 'dev_queue.json')),
    readJsonIfExists(join(currentReportDir, 'regression_lock.json')),
    reportPayload(),
  ]);
  const captureById = new Map((capture?.results ?? []).map((item) => [item.id, item]));
  const lintById = new Map((lints?.results ?? []).map((item) => [item.id, item]));
  const reviewById = new Map((productReview?.screens ?? []).map((item) => [item.id, item]));
  const flowReviewById = new Map((playthroughReview?.flows ?? []).map((item) => [item.flow_id, item]));
  const screens = (matrix?.screens ?? []).map((screen) => {
    const lint = lintById.get(screen.id);
    const review = reviewById.get(screen.id);
    const captured = captureById.get(screen.id);
    return buildScreenView(screen, captured, lint, review);
  });
  const flows = (playthroughMatrix?.flows ?? []).map((flow) => {
    const review = flowReviewById.get(flow.id);
    return buildFlowView(flow, review, playthroughMatrix?.requiredScoreKeys ?? []);
  });
  const allRows = [...screens, ...flows];
  const summary = {
    fail: allRows.filter((row) => row.verdict === 'FAIL').length,
    blocked: allRows.filter((row) => row.verdict === 'BLOCKED').length,
    ruleInvalid: allRows.filter((row) => row.verdict === 'RULE_INVALID').length,
    skip: allRows.filter((row) => row.verdict === 'SKIP').length,
    lowConfidence: 0,
    pass: allRows.filter((row) => row.verdict === 'PASS').length,
    p0: countSeverity(allRows, 'P0'),
    p1: countSeverity(allRows, 'P1'),
    p2: countSeverity(allRows, 'P2'),
    contractPasses: allRows.reduce((sum, row) => sum + row.contractPasses.length, 0),
    contractFailures: allRows.reduce((sum, row) => sum + row.contractFailures.length, 0),
    evidenceGaps: allRows.reduce((sum, row) => sum + row.evidenceGaps.length, 0),
    forbiddenAbsences: allRows.reduce((sum, row) => sum + row.forbiddenAbsences.length, 0),
    qaFailItems: allRows.reduce((sum, row) => sum + row.qaJudgementItems.filter((item) => item.status === 'FAIL').length, 0),
    qaBlockedItems: allRows.reduce((sum, row) => sum + row.qaJudgementItems.filter((item) => item.status === 'BLOCKED').length, 0),
    qaRuleInvalidItems: allRows.reduce((sum, row) => sum + row.qaJudgementItems.filter((item) => item.status === 'RULE_INVALID').length, 0),
    qaPassItems: allRows.reduce((sum, row) => sum + row.qaJudgementItems.filter((item) => item.status === 'PASS').length, 0),
    devQueueItems: (devQueue?.items ?? []).length,
    qaQueueItems: (devQueue?.qa_queue ?? devQueue?.qa_boost_required ?? []).length,
    regressionLockFail: (regressionLock?.screens ?? []).filter((screen) => screen.status === 'FAIL').length,
  };
  return {
    generatedAt: new Date().toISOString(),
    generatedAtKst: formatKst(new Date().toISOString()),
    reportRun: report.reportRun,
    reportStat: report.reportStat
      ? { ...report.reportStat, mtimeKst: formatKst(report.reportStat.mtime) }
      : null,
    liveStatus: withKstTimes(report.liveStatus),
    summary,
    devQueue: devQueue ?? { items: [], qa_queue: [] },
    regressionLock: regressionLock ?? { screens: [] },
    screens,
    flows,
  };
}

async function calibrationProfilePayload() {
  const reportDir = validateReportDir(currentReportDir);
  const profilePath = resolve(reportDir, 'qa_calibration_profile.json');
  ensureInside(reportDir, profilePath);
  const profile = await readJsonIfExists(profilePath);
  return {
    reportDir,
    profilePath,
    profile: normalizeCalibrationProfile(profile ?? {}),
  };
}

async function saveCalibrationProfile(request, response) {
  if (activeJob) {
    return writeJson(response, 409, {
      error: 'QA job 실행 중에는 캘리브레이션 profile을 저장할 수 없습니다.',
      job: publicJob(activeJob),
    });
  }
  let profile;
  try {
    const body = await readRequestJson(request);
    profile = normalizeCalibrationProfile(body.profile ?? body);
  } catch (error) {
    return writeJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const reportDir = validateReportDir(currentReportDir);
  const profilePath = resolve(reportDir, 'qa_calibration_profile.json');
  try {
    ensureInside(reportDir, profilePath);
    await mkdir(reportDir, { recursive: true });
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    await refreshCalibrationReport(reportDir);
  } catch (error) {
    return writeJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return writeJson(response, 200, {
    ok: true,
    reportDir,
    profilePath,
    profile,
    reportUrl: '/report',
  });
}

async function refreshCalibrationReport(reportDir) {
  const screenshotDir = validateReportDir(currentScreenshotDir || join(reportDir, 'screenshots'));
  await runCommand(process.execPath, ['tools/qa_write_current_reviews.mjs'], {
    cwd: runnerRoot,
    env: {
      ...process.env,
      QA_REPORT_DIR: reportDir,
      QA_SCREENSHOT_DIR: screenshotDir,
      QA_PRODUCT_REVIEW_PATH: join(reportDir, 'codex_product_review.json'),
      QA_PLAYTHROUGH_REVIEW_PATH: join(reportDir, 'codex_playthrough_review.json'),
      QA_CALIBRATION_PROFILE_PATH: join(reportDir, 'qa_calibration_profile.json'),
      QA_CALIBRATION_CANDIDATES_PATH: join(reportDir, 'qa_calibration_candidates.json'),
      QA_POLISH_LINTS_PATH: join(reportDir, 'polish_lints.json'),
    },
  });
  await runCommand(process.execPath, ['tools/qa_build_dev_queue.mjs'], {
    cwd: runnerRoot,
    env: {
      ...process.env,
      QA_REPORT_DIR: reportDir,
      QA_SCREENSHOT_DIR: screenshotDir,
      QA_PRODUCT_REVIEW_PATH: join(reportDir, 'codex_product_review.json'),
      QA_PLAYTHROUGH_REVIEW_PATH: join(reportDir, 'codex_playthrough_review.json'),
      QA_DEV_QUEUE_PATH: join(reportDir, 'dev_queue.json'),
      QA_REGRESSION_LOCK_PATH: join(reportDir, 'regression_lock.json'),
    },
  });
  await runCommand(process.execPath, ['tools/qa_generate_html_report.mjs'], {
    cwd: runnerRoot,
    env: {
      ...process.env,
      QA_REPORT_DIR: reportDir,
      QA_SCREENSHOT_DIR: screenshotDir,
      QA_LIVE_STATUS_PATH: join(reportDir, 'qa_live_status.json'),
      QA_MODE: 'full',
    },
  });
}

function buildScreenView(screen, captured, lint, review) {
  const contract = collectContractResults(review?.contract_results);
  const lintFindings = normalizeFindings(lint?.findings ?? []);
  const reviewFindings = normalizeFindings(review?.findings ?? []);
  const recommendedFix = review?.recommended_fix ?? '수정 후보가 아직 기록되지 않았습니다.';
  const scores = review?.scores ?? {};
  const scoreValues = Object.values(scores).filter((value) => typeof value === 'number');
  const lowestScore = scoreValues.length > 0 ? Math.min(...scoreValues) : null;
  const p2Plus = [...lintFindings, ...reviewFindings].some((finding) => severityRank(finding.severity) >= severityRank('P2'));
  const capturedOk = Boolean(captured && ['captured', 'skipped_cached'].includes(captured.status));
  const hardFail =
    !capturedOk ||
    lint?.status === 'fail' ||
    review?.status === 'fail' ||
    review?.ship_readiness === 'needs_polish' ||
    review?.ship_readiness === 'prototype_quality' ||
    contract.failures.length > 0 ||
    p2Plus ||
    (lowestScore !== null && lowestScore < 4);
  const ruleInvalid = review?.status === 'rule_invalid' || review?.ship_readiness === 'rule_invalid';
  const blocked =
    lint?.status === 'low_confidence' ||
    review?.status === 'low_confidence' ||
    review?.status === 'blocked' ||
    review?.ship_readiness === 'evidence_missing' ||
    contract.evidenceGaps.length > 0;
  const verdict = hardFail ? 'FAIL' : ruleInvalid ? 'RULE_INVALID' : blocked ? 'BLOCKED' : 'PASS';
  const qaJudgementItems = ensureQaJudgementItems(buildQaJudgementItems({
    contract,
    lintFindings,
    reviewFindings,
    fixedRules: review?.fixed_rules ?? [],
    recommendedFix,
  }), verdict, {
    targetLabel: `${screen.screen} / ${screen.state}`,
    evidence: !capturedOk
      ? `${screen.screenshot} 캡처가 현재 QA 산출물에서 확인되지 않습니다.`
      : `${screen.screen} 화면의 Codex 제품 검수 근거가 충분하지 않습니다.`,
    nextAction: !capturedOk
      ? `${screen.screenshot}를 390x844 원본 크기로 다시 캡처하고 재검수하세요.`
      : '제품 검수 review_note, finding, 원본 캡처 확인 근거를 보강해 재검수하세요.',
  });
  return {
    type: 'screen',
    id: screen.id,
    title: screen.screen,
    state: screen.state,
    screenshot: `/screenshots/${screen.screenshot}`,
    verdict,
    captureStatus: captured?.status ?? 'missing',
    capturedAtKst: formatKst(captured?.mtime),
    lintStatus: lint?.status ?? 'missing',
    codexStatus: review?.ship_readiness ?? review?.status ?? 'missing',
    scores,
    lowestScore,
    primaryFailure: qaJudgementItems.find((item) => item.status === 'FAIL') ??
      qaJudgementItems.find((item) => item.status === 'BLOCKED') ??
      qaJudgementItems.find((item) => item.status === 'RULE_INVALID') ??
      null,
    qaJudgementItems,
    qaJudgementSummary: summarizeQaJudgementItems(qaJudgementItems),
    contractPasses: contract.passes,
    contractFailures: contract.failures,
    evidenceGaps: contract.evidenceGaps,
    forbiddenAbsences: contract.forbiddenAbsences,
    contractSummary: contract.summary,
    contractRows: contract.rows,
    lintFindings,
    reviewFindings,
    recommendedFix,
    updatedAtKst: formatKst(review?.generated_at ?? captured?.mtime),
  };
}

function buildFlowView(flow, review, scoreKeys) {
  const contract = collectFlowContractResults(review);
  const findings = normalizeFindings(review?.findings ?? []);
  const recommendedFix = review?.recommended_fix ?? '플레이 흐름 검수와 transcript 작성이 필요합니다.';
  const scores = review?.scenario_scores ?? {};
  const scoreValues = scoreKeys.map((key) => scores[key]).filter((value) => typeof value === 'number');
  const lowestScore = scoreValues.length > 0 ? Math.min(...scoreValues) : null;
  const p2Plus = findings.some((finding) => severityRank(finding.severity) >= severityRank('P2'));
  const hardFail =
    review?.verdict === 'fail' ||
    contract.failures.length > 0 ||
    p2Plus ||
    (lowestScore !== null && lowestScore < 4);
  const ruleInvalid = review?.verdict === 'rule_invalid';
  const blocked = review?.verdict === 'low_confidence' || review?.verdict === 'blocked' || contract.evidenceGaps.length > 0 || !review;
  const verdict = hardFail ? 'FAIL' : ruleInvalid ? 'RULE_INVALID' : blocked ? 'BLOCKED' : 'PASS';
  const qaJudgementItems = ensureQaJudgementItems(buildQaJudgementItems({
    contract,
    reviewFindings: findings,
    fixedRules: review?.fixed_rules ?? [],
    recommendedFix,
  }), verdict, {
    targetLabel: flow.title,
    evidence: review
      ? `${flow.title} 흐름의 판단 근거가 충분하지 않습니다.`
      : `${flow.title} 흐름의 Codex playthrough review가 현재 QA 산출물에 없습니다.`,
    nextAction: '실제 한국어 transcript와 CTA/선택/결과 연결 근거를 추가해 재검수하세요.',
  });
  return {
    type: 'flow',
    id: flow.id,
    title: flow.title,
    state: (flow.steps ?? []).join(' → '),
    screenshot: null,
    verdict,
    captureStatus: 'not_applicable',
    capturedAtKst: null,
    lintStatus: 'not_applicable',
    codexStatus: review?.verdict ?? 'missing',
    scores,
    lowestScore,
    primaryFailure: qaJudgementItems.find((item) => item.status === 'FAIL') ??
      qaJudgementItems.find((item) => item.status === 'BLOCKED') ??
      qaJudgementItems.find((item) => item.status === 'RULE_INVALID') ??
      null,
    qaJudgementItems,
    qaJudgementSummary: summarizeQaJudgementItems(qaJudgementItems),
    contractPasses: contract.passes,
    contractFailures: contract.failures,
    evidenceGaps: contract.evidenceGaps,
    forbiddenAbsences: contract.forbiddenAbsences,
    contractSummary: contract.summary,
    contractRows: contract.rows,
    lintFindings: [],
    reviewFindings: findings,
    transcript: review?.transcript ?? [],
    recommendedFix,
    updatedAtKst: formatKst(review?.generated_at),
  };
}

function collectContractResults(contractResults) {
  const groups = [
    ...(contractResults?.expected ?? []).map((item) => ({ ...item, category: 'expected' })),
    ...(contractResults?.implementedEvidence ?? []).map((item) => ({ ...item, category: 'implementedEvidence' })),
    ...(contractResults?.forbidden ?? []).map((item) => ({ ...item, category: 'forbidden' })),
  ];
  return collectContractRows(groups);
}

function collectFlowContractResults(review) {
  const groups = [
    ...(review?.expectedFlow ?? []).map((item) => ({ ...item, category: 'expectedFlow' })),
    ...(review?.observedFlow ?? []).map((item) => ({ ...item, category: 'observedFlow' })),
    ...(review?.forbiddenFlowBreaks ?? []).map((item) => ({ ...item, category: 'forbiddenFlowBreaks' })),
  ];
  return collectContractRows(groups);
}

function collectContractRows(groups) {
  const rows = groups.map(formatContractItem);
  return {
    rows,
    passes: rows.filter((item) => item.normalizedStatus === 'pass'),
    failures: rows.filter((item) => item.normalizedStatus === 'fail' || item.normalizedStatus === 'forbidden_present'),
    evidenceGaps: rows.filter((item) => item.normalizedStatus === 'evidence_gap'),
    forbiddenAbsences: rows.filter((item) => item.normalizedStatus === 'forbidden_absent'),
    summary: summarizeContractRows(rows),
  };
}

function buildQaJudgementItems({
  contract,
  lintFindings = [],
  reviewFindings = [],
  fixedRules = [],
  recommendedFix = '',
}) {
  const fixedRuleById = new Map(fixedRules.map((rule) => [rule.rule_id, rule]));
  const items = [];
  for (const finding of [...reviewFindings, ...lintFindings]) {
    if (!finding.rule_id && severityRank(finding.severity) < severityRank('P2')) continue;
    const rule = fixedRuleById.get(finding.rule_id);
    items.push({
      key: finding.rule_id ? `rule:${finding.rule_id}` : `finding:${finding.code || finding.message}`,
      source: finding.rule_id ? 'fixed_rule' : 'review_finding',
      status: 'FAIL',
      severity: finding.severity || rule?.severity || 'P2',
      criterionId: finding.rule_id || finding.code || 'review_finding',
      criterionName: rule?.assertion || finding.rule_id || finding.code || '제품 검수 finding',
      observedEvidence:
        finding.observed_evidence ||
        finding.message ||
        '현재 검수 finding이 남아 있어 FAIL입니다.',
      passCriteria:
        finding.pass_criteria ||
        rule?.pass_criteria ||
        '동일 finding이 재검수에서 재현되지 않아야 합니다.',
      nextAction:
        rule?.recommended_fix ||
        recommendedFix ||
        '해당 finding을 제거하도록 화면/문구/흐름을 수정하세요.',
    });
  }
  for (const row of contract?.rows ?? []) {
    items.push(contractRowToJudgementItem(row, recommendedFix));
  }
  return dedupeQaJudgementItems(items).sort((a, b) => {
    const rank = { FAIL: 0, BLOCKED: 1, RULE_INVALID: 2, PASS: 3, SKIP: 4 };
    const statusDelta = rank[a.status] - rank[b.status];
    if (statusDelta !== 0) return statusDelta;
    return severityRank(b.severity) - severityRank(a.severity);
  });
}

function ensureQaJudgementItems(items, verdict, fallback) {
  if (items.length > 0 || verdict === 'PASS') return items;
  const status = verdict === 'BLOCKED' ? 'BLOCKED' : verdict === 'RULE_INVALID' ? 'RULE_INVALID' : verdict === 'SKIP' ? 'SKIP' : 'FAIL';
  return [{
    key: `fallback:${fallback.targetLabel}`,
    source: 'fallback',
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
  const status = contractJudgementStatus(row.normalizedStatus);
  return {
    key: `contract:${row.category}:${row.id || row.label}`,
    source: 'contract',
    status,
    severity: status === 'FAIL' ? 'P2' : status === 'BLOCKED' ? 'P3' : '',
    criterionId: row.id,
    criterionName: row.label,
    observedEvidence: contractObservedEvidence(row, status),
    passCriteria: row.label,
    nextAction: judgementNextAction(status, recommendedFix, row.label),
  };
}

function contractJudgementStatus(status) {
  if (status === 'fail' || status === 'forbidden_present') return 'FAIL';
  if (status === 'evidence_gap') return 'BLOCKED';
  return 'PASS';
}

function contractObservedEvidence(row, status) {
  if (row.note && row.note !== row.label) return row.note;
  if (status === 'FAIL') return `${row.label} 기준이 현재 산출물에서 충족되지 않았습니다.`;
  if (status === 'BLOCKED') {
    return `${row.label} 기준을 판정할 원본 캡처, transcript, 동작 증거가 아직 충분하지 않습니다.`;
  }
  return `${row.label} 기준이 현재 산출물에서 확인됐습니다.`;
}

function judgementNextAction(status, recommendedFix, label) {
  if (status === 'FAIL') {
    return recommendedFix || `${label} 기준을 만족하도록 UI/문구/흐름을 수정하세요.`;
  }
  if (status === 'BLOCKED') {
    return `${label} 기준을 판정할 원본 크기 캡처, 상호작용 기록, 또는 한국어 transcript를 추가해 재검수하세요.`;
  }
  if (status === 'RULE_INVALID') {
    return `${label} 기준을 passIf/failIf/blockedIf가 있는 판정 가능한 룰로 다시 작성하세요.`;
  }
  return '추가 조치 없음';
}

function dedupeQaJudgementItems(items) {
  const priority = { FAIL: 5, BLOCKED: 4, RULE_INVALID: 3, PASS: 2, SKIP: 1 };
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
    else if (item.status === 'BLOCKED') summary.blocked += 1;
    else if (item.status === 'RULE_INVALID') summary.ruleInvalid += 1;
    else if (item.status === 'SKIP') summary.skip += 1;
    else summary.pass += 1;
    return summary;
  }, { total: 0, fail: 0, blocked: 0, ruleInvalid: 0, skip: 0, pass: 0 });
}

function formatContractItem(item) {
  const normalizedStatus = normalizeContractStatus(item.status);
  return {
    id: item.id ?? '',
    category: item.category ?? 'contract',
    label: item.label ?? item.id ?? '계약 항목',
    status: item.status ?? 'missing',
    normalizedStatus,
    displayStatus: contractDisplayStatus(normalizedStatus, item),
    reason: contractReason(item),
    note: item.note ?? '',
  };
}

function summarizeContractRows(rows) {
  return rows.reduce((summary, row) => {
    summary.total += 1;
    if (row.normalizedStatus === 'pass') summary.pass += 1;
    else if (row.normalizedStatus === 'evidence_gap') summary.evidenceGap += 1;
    else if (row.normalizedStatus === 'forbidden_absent') summary.forbiddenAbsent += 1;
    else if (row.normalizedStatus === 'forbidden_present') summary.forbiddenPresent += 1;
    else summary.fail += 1;
    return summary;
  }, { total: 0, pass: 0, fail: 0, evidenceGap: 0, forbiddenAbsent: 0, forbiddenPresent: 0 });
}

function normalizeContractStatus(status) {
  if (status === 'pass') return 'pass';
  if (status === 'absent') return 'forbidden_absent';
  if (status === 'present') return 'forbidden_present';
  if (status === 'not_observed') return 'evidence_gap';
  if (status === 'fail') return 'fail';
  return 'evidence_gap';
}

function contractDisplayStatus(status, item = {}) {
  if (status === 'pass') return 'PASS';
  if (status === 'forbidden_absent') return 'PASS';
  if (status === 'forbidden_present') return 'FAIL';
  if (status === 'evidence_gap') return 'BLOCKED';
  return 'FAIL';
}

function contractReason(item) {
  if (item.note && item.note !== item.label) return item.note;
  const label = item.label ?? item.id ?? '계약 항목';
  if (item.status === 'present') return `금지 항목이 관찰됐습니다: ${label}`;
  if (item.status === 'not_observed') {
    if (item.category === 'forbidden' || item.category === 'forbiddenFlowBreaks') {
      return `BLOCKED: ${label} 항목이 없다고 판정할 관찰 근거가 더 필요합니다.`;
    }
    return `BLOCKED: ${label} 기준을 판정할 관찰 근거가 더 필요합니다.`;
  }
  if (item.status === 'fail') {
    if (item.category === 'implementedEvidence' || item.category === 'observedFlow') {
      return `FAIL: ${label} 기준이 현재 산출물에서 충족되지 않았습니다.`;
    }
    if (item.category === 'forbidden' || item.category === 'forbiddenFlowBreaks') {
      return `금지 항목이 관찰됐습니다: ${label}`;
    }
    return `FAIL: ${label} 기준이 현재 산출물에서 충족되지 않았습니다.`;
  }
  if (item.status === 'pass' || item.status === 'absent') return `PASS: ${label} 기준 확인`;
  return `${label} 기준 확인 필요`;
}

function normalizeFindings(findings) {
  return findings.map((finding) => ({
    severity: finding.severity ?? '',
    code: finding.code ?? '',
    message: finding.message ?? finding.note ?? '',
    rule_id: finding.rule_id ?? '',
    target_id: finding.target_id ?? '',
    source_candidate_id: finding.source_candidate_id ?? '',
    observed_evidence: finding.observed_evidence ?? '',
    pass_criteria: finding.pass_criteria ?? '',
  }));
}

function countSeverity(rows, severity) {
  return rows.reduce(
    (sum, row) => sum +
      [...row.lintFindings, ...row.reviewFindings].filter((finding) => finding.severity === severity).length,
    0,
  );
}

function severityRank(severity) {
  return { P0: 4, P1: 3, P2: 2, P3: 1 }[severity] ?? 0;
}

function withKstTimes(liveStatus) {
  if (!liveStatus) return null;
  return {
    ...liveStatus,
    started_at_kst: formatKst(liveStatus.started_at),
    updated_at_kst: formatKst(liveStatus.updated_at),
    events: (liveStatus.events ?? []).map((event) => ({
      ...event,
      at_kst: formatKst(event.at),
    })),
  };
}

function reportRunPayload(liveStatus, reportStat) {
  const reportMtime = reportStat?.mtime ? Date.parse(reportStat.mtime) : null;
  const runStarted = liveStatus?.started_at ? Date.parse(liveStatus.started_at) : null;
  const activeStatuses = new Set(['queued', 'running']);
  const isCurrentRunActive = activeStatuses.has(liveStatus?.status);
  const reportIsFromCurrentRun =
    reportMtime !== null &&
    runStarted !== null &&
    reportMtime >= runStarted &&
    !isCurrentRunActive;
  return {
    runId: liveStatus?.run_id ?? null,
    mode: liveStatus?.mode ?? null,
    startedAt: liveStatus?.started_at ?? null,
    startedAtKst: formatKst(liveStatus?.started_at),
    reportMtime: reportStat?.mtime ?? null,
    reportMtimeKst: formatKst(reportStat?.mtime),
    isCurrentRunActive,
    reportIsFromCurrentRun,
    label: isCurrentRunActive
      ? '현재 QA 실행 중: 아래 report는 직전 산출물일 수 있습니다.'
      : reportIsFromCurrentRun
        ? '아래 report는 마지막 QA 실행 결과입니다.'
        : '아래 report는 이전 산출물입니다.',
  };
}

async function screenshotPayload() {
  try {
    const files = await readdir(currentScreenshotDir);
    const pngFiles = files.filter((file) => file.endsWith('.png'));
    return {
      dir: currentScreenshotDir,
      count: pngFiles.length,
      examples: pngFiles.slice(0, 5),
    };
  } catch {
    return {
      dir: currentScreenshotDir,
      count: 0,
      examples: [],
    };
  }
}

function publicJob(job) {
  return {
    id: job.id,
    mode: job.mode,
    targetWorktree: job.targetWorktree,
    reportDir: job.reportDir,
    screenshotDir: job.screenshotDir,
    status: job.status,
    phase: job.phase,
    message: job.message,
    current: job.current,
    total: job.total,
    startedAt: job.startedAt,
    changedFiles: job.changedFiles,
    automatedGate: job.automatedGate,
    codexReview: job.codexReview,
    finalStatus: job.finalStatus,
    nextAction: job.nextAction,
    events: job.events.slice(-20),
    lastOutput: job.lastOutput,
    lastError: job.lastError,
  };
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dragonout QA Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    html, body { max-width: 100%; overflow-x: hidden; }
    body { margin: 0; background: #130d10; color: #f7ebd1; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
    header { padding: 24px 28px; border-bottom: 1px solid rgba(223,184,111,.35); background: #211419; }
    main { width: 100%; margin: 0; padding: 22px; }
    .control-shell { max-width: 1320px; margin: 0 auto; }
    h1, h2 { margin: 0; } h2 { color: #dfb86f; margin-top: 26px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(190px,1fr)); gap: 12px; margin-top: 14px; }
    .card { background: #211419; border: 1px solid rgba(223,184,111,.35); border-radius: 8px; padding: 14px; }
    label { display:block; color:#c9ad84; font-weight:700; margin-top:12px; }
    input, textarea { width:100%; box-sizing:border-box; border-radius:6px; border:1px solid rgba(223,184,111,.35); background:#130d10; color:#f7ebd1; padding:9px; }
    textarea { min-height: 90px; }
    button { border:1px solid #dfb86f; background:#2d1d22; color:#f7ebd1; border-radius:6px; padding:10px 12px; font-weight:800; margin: 8px 8px 0 0; cursor:pointer; }
    button:hover { background:#3a252b; }
    a { color:#f7ebd1; }
    .fail { color:#ff7b72; } .pass { color:#7fd29b; } .low { color:#e5b567; }
    pre { white-space: pre-wrap; overflow:auto; max-height:260px; }
    .run-banner { margin-top:14px; border-radius:8px; border:1px solid rgba(229,181,103,.56); background:#2d2418; padding:12px 14px; color:#f7ebd1; font-weight:800; }
    .run-banner.current { border-color:#e5b567; }
    .run-banner.stale { border-color:#ff7b72; background:#30191b; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    .actions a { display:inline-flex; align-items:center; min-height:38px; border:1px solid #dfb86f; background:#2d1d22; border-radius:6px; padding:0 12px; text-decoration:none; font-weight:800; }
    .changed { border-color:#7fd29b; box-shadow: 0 0 0 1px rgba(127,210,155,.32) inset; }
    .report-inline { margin-top: 18px; border-top: 1px solid rgba(223,184,111,.35); background:#130d10; }
    .report-inline-head { max-width: 1120px; margin: 0 auto; padding: 20px 24px 0; color:#c9ad84; }
    #qaReportHost { display:block; width:100%; max-width:1120px; margin:0 auto; min-height: 280px; overflow-x:hidden; padding: 0 24px 44px; }
    .qa-view-summary { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin: 14px 0 18px; }
    .qa-view-card { background:#211419; border:1px solid rgba(223,184,111,.35); border-radius:8px; padding:14px; min-width:0; }
    .qa-view-card strong { display:block; color:#dfb86f; font-size:12px; }
    .qa-view-card span { font-size:20px; font-weight:900; }
    .qa-section-title { display:flex; align-items:center; justify-content:space-between; gap:12px; margin: 28px 0 12px; }
    .qa-section-title h3 { margin:0; color:#dfb86f; font-size:18px; }
    .qa-item-grid { display:grid; grid-template-columns: 1fr; gap:16px; width:100%; max-width:1120px; margin:0 auto; overflow-x:hidden; }
    .qa-item { display:grid; grid-template-columns: 240px minmax(0, 1fr); gap:18px; background:#211419; border:1px solid rgba(223,184,111,.35); border-radius:8px; padding:16px; min-width:0; }
    .qa-item.fail { border-color:rgba(255,123,114,.72); background:#251318; }
    .qa-item.low { border-color:rgba(229,181,103,.72); background:#231b13; }
    .qa-thumb { width:100%; max-width:240px; border-radius:5px; border:1px solid rgba(223,184,111,.35); display:block; }
    .qa-flow-thumb { width:100%; max-width:240px; min-height:184px; border:1px dashed rgba(223,184,111,.35); border-radius:5px; display:flex; align-items:center; justify-content:center; color:#c9ad84; text-align:center; padding:8px; }
    .qa-item-main { min-width:0; }
    .qa-item-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:8px; }
    .qa-item-title { font-weight:900; font-size:16px; }
    .qa-item-state, .qa-muted { color:#c9ad84; font-size:12px; }
    .badge { display:inline-flex; align-items:center; min-height:24px; padding:2px 9px; border:1px solid currentColor; border-radius:999px; font-size:12px; font-weight:900; white-space:nowrap; }
    .badge.pass { color:#7fd29b; background:rgba(127,210,155,.07); }
    .badge.fail { color:#ff7b72; background:rgba(255,123,114,.08); }
    .badge.low { color:#e5b567; background:rgba(229,181,103,.08); }
    .qa-fix { margin:10px 0; padding:10px; border-radius:6px; background:#130d10; border:1px solid rgba(223,184,111,.22); overflow-wrap:anywhere; word-break:keep-all; }
    .qa-fix strong, .qa-block strong { color:#dfb86f; font-size:12px; }
    .qa-contract-summary { margin-top:10px; display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:8px; }
    .qa-contract-pill { border:1px solid rgba(223,184,111,.24); border-radius:6px; padding:8px; background:#130d10; min-width:0; }
    .qa-contract-pill b { display:block; color:#c9ad84; font-size:11px; }
    .qa-contract-pill span { font-weight:900; font-size:16px; }
    .qa-contract-ok { margin-top:10px; border:1px solid rgba(127,210,155,.42); background:rgba(127,210,155,.07); color:#7fd29b; border-radius:6px; padding:10px; font-weight:900; }
    .qa-status-line { display:flex; align-items:flex-start; gap:8px; flex-wrap:wrap; }
    .contract-status { display:inline-flex; min-width:84px; justify-content:center; align-items:center; min-height:22px; padding:1px 8px; border-radius:999px; border:1px solid currentColor; font-size:11px; font-weight:900; }
    .qa-block { margin-top:10px; min-width:0; }
    .qa-list { margin:6px 0 0; padding-left:18px; }
    .qa-list li { margin:4px 0; overflow-wrap:anywhere; word-break:keep-all; }
    .qa-meta { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
    .qa-judgement-list { display:grid; gap:8px; margin-top:8px; }
    .qa-judgement-card { border:1px solid rgba(223,184,111,.22); border-radius:6px; background:#130d10; padding:10px; }
    .qa-judgement-card.fail { border-color:rgba(255,123,114,.45); }
    .qa-judgement-card.low { border-color:rgba(229,181,103,.45); }
    .qa-judgement-fields { display:grid; gap:3px; margin-top:6px; font-size:12px; color:#c9ad84; }
    .qa-judgement-fields b { color:#dfb86f; }
    details.qa-details { margin-top:10px; border-top:1px solid rgba(223,184,111,.18); padding-top:8px; }
    details.qa-details summary { color:#dfb86f; cursor:pointer; font-weight:800; }
    @media (max-width: 1180px) {
      main { padding: 14px; }
      #qaReportHost { padding: 0 14px 36px; }
      .qa-item-grid { grid-template-columns: 1fr; }
      .qa-item { grid-template-columns: 200px minmax(0, 1fr); }
    }
    @media (max-width: 640px) {
      .qa-item { grid-template-columns: 1fr; }
      .qa-thumb, .qa-flow-thumb { width: min(220px, 100%); }
    }
  </style>
</head>
<body>
  <header>
    <h1>Dragonout QA Dashboard</h1>
    <p>이 화면은 QA 실행 제어면입니다. report.html은 읽기 전용 산출물입니다.</p>
    <p class="qa-muted">Dashboard UI: ${escapeHtml(dashboardVersion)} / Runner: ${escapeHtml(runnerRoot)} / Canonical: ${escapeHtml(canonicalRunnerRoot)}</p>
  </header>
  <main>
    <div class="control-shell">
    <section class="card">
      <label>Target worktree</label>
      <input id="targetWorktree" value="${escapeHtml(defaultTarget)}">
      <label>Report dir</label>
      <input id="reportDir" value="${escapeHtml(currentReportDir)}">
      <label>Screenshot dir</label>
      <input id="screenshotDir" value="${escapeHtml(currentScreenshotDir)}">
      <label>Changed files (Fast QA)</label>
      <textarea id="changedFiles" placeholder="lib/widgets/game_widgets.dart&#10;lib/l10n/app_ko.arb"></textarea>
      <button onclick="runQa('fast')">Fast QA</button>
      <button onclick="runQa('full')">Full QA</button>
      <button onclick="refreshReport()">Report만 갱신</button>
      <button onclick="cancelQa()">Cancel</button>
      <a id="reportButton" href="/report" target="_blank"><button type="button">Report 새 탭</button></a>
    </section>
    <section>
      <h2>Live Status</h2>
      <div id="runBanner" class="run-banner">QA 상태를 불러오는 중입니다.</div>
      <div id="summary" class="grid"></div>
      <div class="card"><pre id="events"></pre></div>
    </section>
    <section>
      <h2>Report</h2>
      <p class="low">Dashboard 아래에 최신 QA 수정 큐를 카드로 표시합니다. 상세 산출물은 필요할 때만 새 탭으로 크게 열 수 있습니다.</p>
      <p class="qa-muted">QA 판정 상태: PASS / FAIL / BLOCKED / RULE_INVALID / SKIP</p>
      <div id="reportSummary" class="grid"></div>
      <div class="actions">
        <a id="reportInlineLink" href="#qaReportHost">수정 큐로 이동</a>
        <a id="reportNewTabLink" href="/report" target="_blank">상세 HTML report</a>
      </div>
    </section>
    </div>
    <section class="report-inline" aria-label="Inline QA report">
      <div id="inlineReportHead" class="report-inline-head">아래는 QA report를 같은 페이지에 이어 붙인 영역입니다.</div>
      <div id="qaReportHost"></div>
    </section>
  </main>
  <script>
    let lastReportMtime = null;
    let lastRenderedReportViewMtime = null;
    let pollTimer = null;
    let pollInFlight = false;
    let lastPollDelayMs = 0;
    async function post(url, body = {}) {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await response.json();
      if (!response.ok) alert(json.error || 'request failed');
      await pollNow();
    }
    function body() {
      return {
        targetWorktree: document.getElementById('targetWorktree').value,
        reportDir: document.getElementById('reportDir').value,
        screenshotDir: document.getElementById('screenshotDir').value,
        changedFiles: document.getElementById('changedFiles').value,
      };
    }
    async function runQa(mode) { await post('/api/run/' + mode, body()); }
    async function refreshReport() { await post('/api/refresh-report', body()); }
    async function cancelQa() { await post('/api/cancel'); }
    function tone(value) {
      if (value === 'complete') return 'pass';
      if (value === 'failed' || value === 'cancelled') return 'fail';
      return 'low';
    }
    function gateTone(value) {
      if (value === 'pass') return 'pass';
      if (value === 'fail') return 'fail';
      return 'low';
    }
    async function pollNow() {
      if (pollInFlight) return;
      pollInFlight = true;
      let data = null;
      try {
        data = await (await fetch('/api/status')).json();
        lastPollDelayMs = pollDelayMs(data);
        await renderStatus(data);
      } catch (error) {
        const banner = document.getElementById('runBanner');
        if (banner) {
          banner.className = 'run-banner stale';
          banner.textContent = 'Dashboard 상태 갱신 실패 — ' + (error?.message || error);
        }
      } finally {
        pollInFlight = false;
        schedulePoll(data);
      }
    }
    async function renderStatus(data) {
      const job = data.activeJob || data.lastJob || {};
      const live = data.report.liveStatus || {};
      const server = data.server || {};
      const reportMtime = data.report.reportStat ? data.report.reportStat.mtime : '';
      const reportChanged = Boolean(lastReportMtime && reportMtime && lastReportMtime !== reportMtime);
      if (reportMtime) lastReportMtime = reportMtime;
      const reportHref = reportMtime ? ('/report?t=' + encodeURIComponent(reportMtime)) : '/report';
      document.getElementById('reportButton').href = reportHref;
      document.getElementById('reportNewTabLink').href = reportHref;
      const runInfo = data.report.reportRun || {};
      const activeRunId = job.id || live.run_id || '-';
      const activeStartedAt = job.startedAt || live.started_at || '-';
      document.getElementById('runBanner').className = 'run-banner ' + (runInfo.isCurrentRunActive ? 'current' : runInfo.reportIsFromCurrentRun ? '' : 'stale');
      document.getElementById('runBanner').textContent = 'Run ' + activeRunId + ' / ' + (job.mode || live.mode || '-') + ' / 시작 ' + formatKst(activeStartedAt) + ' — ' + (runInfo.label || 'report 상태 확인 중');
      document.getElementById('inlineReportHead').textContent = (runInfo.label || '아래는 QA report입니다.') + ' Report 갱신: ' + formatKst(reportMtime);
      document.getElementById('summary').innerHTML = [
        ['Run ID', activeRunId, runInfo.isCurrentRunActive ? 'low' : ''],
        ['Dashboard UI', server.dashboardVersion || '-', server.dashboardVersion === '${dashboardVersion}' ? 'pass' : 'fail'],
        ['Server PID', server.pid || '-', ''],
        ['Runner', server.runnerRoot || '-', server.isCanonicalRunner ? 'pass' : 'fail'],
        ['Target', job.targetWorktree || live.target_worktree || document.getElementById('targetWorktree').value || '-', ''],
        ['Run 시작', formatKst(activeStartedAt), ''],
        ['실행 상태', job.status || live.status || 'not_started', tone(job.status || live.status)],
        ['자동 게이트', job.automatedGate || live.automated_gate || 'not_started', gateTone(job.automatedGate || live.automated_gate)],
        ['Codex 검수', job.codexReview || live.codex_review || 'not_entered', gateTone(job.codexReview || live.codex_review)],
        ['최종 상태', job.finalStatus || live.final_status || 'not_started', tone(job.status || live.status)],
        ['단계', job.phase || live.phase || '-'],
        ['진행', ((job.current ?? live.current ?? 0) + '/' + (job.total ?? live.total ?? 0))],
        ['다음 액션', job.nextAction || live.next_action || '-'],
        ['Report', formatKst(reportMtime), reportChanged ? 'pass' : ''],
      ].map(([label, value, cls]) => '<div class="card"><b>' + label + '</b><br><span class="' + (cls || '') + '">' + value + '</span></div>').join('');
      document.getElementById('reportSummary').innerHTML = [
        ['Report 상태', reportChanged ? 'Report 갱신됨' : (reportMtime ? '준비됨' : '없음'), reportChanged ? 'pass' : 'low'],
        ['최근 갱신', formatKst(reportMtime), reportMtime ? 'pass' : 'low'],
        ['Screenshots', (data.report.screenshotStats?.count ?? 0) + ' files', (data.report.screenshotStats?.count ?? 0) > 0 ? 'pass' : 'fail'],
        ['Screenshot dir', data.report.screenshotStats?.dir || '-', ''],
      ].map(([label, value, cls]) => '<div class="card' + (reportChanged && label === 'Report 상태' ? ' changed' : '') + '"><b>' + label + '</b><br><span class="' + (cls || '') + '">' + value + '</span></div>').join('');
      const events = job.events || live.events || [];
      const error = job.lastError || live.last_error;
      document.getElementById('events').textContent = [
        error ? 'Last error:\\n' + error + '\\n' : '',
        events.slice(-14).reverse().map((event) => '[' + formatKst(event.at) + '] ' + event.status + ' / ' + event.phase + ' - ' + event.message).join('\\n')
      ].filter(Boolean).join('\\n');
      if (reportMtime && reportMtime !== lastRenderedReportViewMtime) {
        await renderReportView(reportMtime);
      }
    }
    function schedulePoll(data) {
      if (pollTimer) clearTimeout(pollTimer);
      lastPollDelayMs = pollDelayMs(data);
      pollTimer = setTimeout(pollNow, lastPollDelayMs);
    }
    function pollDelayMs(data) {
      if (document.visibilityState === 'hidden') return 30000;
      const job = data?.activeJob || data?.lastJob || {};
      const live = data?.report?.liveStatus || {};
      const status = job.status || live.status || 'not_started';
      if (status === 'running' || status === 'queued') return 1500;
      return 10000;
    }
    async function renderReportView(reportMtime) {
      const host = document.getElementById('qaReportHost');
      if (!host) return;
      const response = await fetch('/api/report-view?t=' + encodeURIComponent(reportMtime), { cache: 'no-store' });
      if (!response.ok) {
        host.innerHTML = '<div class="qa-view-card fail">Report view를 불러오지 못했습니다.</div>';
        return;
      }
      const view = await response.json();
      host.innerHTML = renderQaView(view);
      lastRenderedReportViewMtime = reportMtime;
    }
    function renderQaView(view) {
      const rows = [...(view.screens || []), ...(view.flows || [])];
      const failRows = rows.filter((row) => row.verdict === 'FAIL');
      const blockedRows = rows.filter((row) => row.verdict === 'BLOCKED' || row.verdict === 'RULE_INVALID' || row.verdict === 'SKIP');
      const passRows = rows.filter((row) => row.verdict === 'PASS');
      return [
        renderQaSummary(view),
        renderDevQueueSection('수정 큐', view.devQueue?.items || []),
        renderDevQueueSection('QA Queue', view.devQueue?.qa_queue || view.devQueue?.qa_boost_required || []),
        renderQaSection('FAIL 수정 큐', failRows, true),
        renderQaSection('BLOCKED / RULE_INVALID / SKIP', blockedRows, true),
        renderQaSection('PASS 참고', passRows, false),
      ].join('');
    }
    function renderQaSummary(view) {
      const s = view.summary || {};
      const run = view.reportRun || {};
      return '<div class="qa-view-summary">' + [
        ['FAIL', s.fail ?? 0, 'fail'],
        ['BLOCKED', s.blocked ?? 0, (s.blocked ?? 0) > 0 ? 'low' : 'pass'],
        ['RULE_INVALID', s.ruleInvalid ?? 0, (s.ruleInvalid ?? 0) > 0 ? 'low' : 'pass'],
        ['LOW_CONFIDENCE', 0, 'pass'],
        ['PASS', s.pass ?? 0, 'pass'],
        ['P0/P1/P2', (s.p0 ?? 0) + '/' + (s.p1 ?? 0) + '/' + (s.p2 ?? 0), ((s.p0 ?? 0) + (s.p1 ?? 0) + (s.p2 ?? 0)) > 0 ? 'fail' : 'pass'],
        ['FAIL 판정 항목', s.qaFailItems ?? 0, (s.qaFailItems ?? 0) > 0 ? 'fail' : 'pass'],
        ['BLOCKED 판정 항목', s.qaBlockedItems ?? 0, (s.qaBlockedItems ?? 0) > 0 ? 'low' : 'pass'],
        ['RULE_INVALID 판정 항목', s.qaRuleInvalidItems ?? 0, (s.qaRuleInvalidItems ?? 0) > 0 ? 'low' : 'pass'],
        ['Dev Queue', s.devQueueItems ?? 0, (s.devQueueItems ?? 0) > 0 ? 'fail' : 'pass'],
        ['QA Queue', s.qaQueueItems ?? 0, (s.qaQueueItems ?? 0) > 0 ? 'low' : 'pass'],
        ['Regression Lock FAIL', s.regressionLockFail ?? 0, (s.regressionLockFail ?? 0) > 0 ? 'fail' : 'pass'],
        ['PASS 판정 항목', s.qaPassItems ?? 0, 'pass'],
        ['Report 갱신', view.reportStat?.mtimeKst || '없음', view.reportStat ? 'pass' : 'low'],
        ['Run 관계', run.label || '확인 중', run.isCurrentRunActive ? 'low' : run.reportIsFromCurrentRun ? 'pass' : 'fail'],
        ['자동 갱신', Math.round(lastPollDelayMs / 1000) + '초', 'low'],
      ].map(([label, value, tone]) => '<div class="qa-view-card"><strong>' + esc(label) + '</strong><span class="' + tone + '">' + esc(value) + '</span></div>').join('') + '</div>';
    }
    function renderQaSection(title, rows, open) {
      const body = rows.length
        ? '<div class="qa-item-grid">' + rows.map(renderQaItem).join('') + '</div>'
        : '<div class="qa-view-card"><span class="qa-muted">해당 항목 없음</span></div>';
      if (open) {
        return '<section><div class="qa-section-title"><h3>' + esc(title) + '</h3><span class="badge low">' + rows.length + '</span></div>' + body + '</section>';
      }
      return '<details class="qa-details"><summary>' + esc(title) + ' (' + rows.length + ')</summary>' + body + '</details>';
    }
    function renderDevQueueSection(title, items) {
      const body = items.length
        ? '<div class="qa-item-grid">' + items.map(renderDevQueueItem).join('') + '</div>'
        : '<div class="qa-view-card"><span class="qa-muted">해당 항목 없음</span></div>';
      return '<section><div class="qa-section-title"><h3>' + esc(title) + '</h3><span class="badge low">' + items.length + '</span></div>' + body + '</section>';
    }
    function renderDevQueueItem(item) {
      const tone = item.status === 'PASS' ? 'pass' : ['BLOCKED', 'RULE_INVALID', 'SKIP'].includes(item.status) ? 'low' : 'fail';
      const evidence = item.evidence || {};
      const missing = Array.isArray(item.missing_evidence) && item.missing_evidence.length
        ? '<div><strong>필요 증거</strong><br>' + esc(item.missing_evidence.join(', ')) + '</div>'
        : '';
      return '<article class="qa-item ' + tone + '"><div class="qa-item-main">' +
        '<div class="qa-item-head"><div><div class="qa-item-title">' + esc(item.id) + '</div><div class="qa-item-state">' + esc(item.target_type + ' · ' + item.target_id) + '</div></div>' + badge(item.status) + '</div>' +
        '<div class="qa-meta">' + badge(item.severity || '-') + badge(item.category || '-') + '</div>' +
        '<div class="qa-fix"><strong>검출 근거</strong><br>' + esc(evidence.observed || '') + '</div>' +
        '<div class="qa-fix"><strong>수정 방향</strong><br>' + esc(item.recommended_fix || '') + '</div>' +
        '<div class="qa-fix"><strong>통과 기준</strong><br>' + esc(item.pass_condition || '') + '</div>' +
        missing +
        '<div class="qa-muted">source: ' + esc(item.source_pointer || '') + '</div>' +
      '</div></article>';
    }
    function renderQaItem(row) {
      const tone = row.verdict === 'PASS' ? 'pass' : ['BLOCKED', 'RULE_INVALID', 'SKIP'].includes(row.verdict) ? 'low' : 'fail';
      const media = row.screenshot
        ? '<a href="' + esc(row.screenshot) + '" target="_blank"><img class="qa-thumb" src="' + esc(row.screenshot) + '" alt="' + esc(row.id) + '"></a>'
        : '<div class="qa-flow-thumb">Playthrough<br>' + esc(row.id) + '</div>';
      return '<article class="qa-item ' + tone + '">' + media + '<div class="qa-item-main">' +
        '<div class="qa-item-head"><div><div class="qa-item-title">' + esc(row.title) + '</div><div class="qa-item-state">' + esc(row.state || row.id) + '</div></div>' + badge(row.verdict) + '</div>' +
        '<div class="qa-meta">' + badge('자동 ' + (row.lintStatus || '-')) + badge('Codex ' + (row.codexStatus || '-')) + badge('최저점 ' + (row.lowestScore ?? '-')) + '</div>' +
        renderJudgementSummary(row) +
        (row.primaryFailure ? '<div class="qa-fix"><strong>판정 사유</strong><br>' + renderJudgementLine(row.primaryFailure) + '</div>' : '<div class="qa-contract-ok">QA 판정 항목이 모두 PASS입니다.</div>') +
        renderJudgementItems(row) +
        '<div class="qa-fix"><strong>수정 후보</strong><br>' + esc(row.recommendedFix || '수정 후보 없음') + '</div>' +
        renderJudgementDetails(row) +
        renderFindingDetails('자동 검사', row.lintFindings || []) +
        renderFindingDetails('Codex 제품/흐름 검수', row.reviewFindings || []) +
        (row.transcript?.length ? renderTextDetails('Transcript', row.transcript) : '') +
        '<div class="qa-muted">캡처: ' + esc(row.capturedAtKst || '없음') + ' / 갱신: ' + esc(row.updatedAtKst || '없음') + '</div>' +
      '</div></article>';
    }
    function renderJudgementSummary(row) {
      const s = row.qaJudgementSummary || {};
      return '<div class="qa-block"><strong>QA 판정 요약</strong><div class="qa-contract-summary">' +
        contractPill('FAIL', s.fail ?? 0, (s.fail ?? 0) > 0 ? 'fail' : 'pass') +
        contractPill('BLOCKED', s.blocked ?? 0, (s.blocked ?? 0) > 0 ? 'low' : 'pass') +
        contractPill('RULE_INVALID', s.ruleInvalid ?? 0, (s.ruleInvalid ?? 0) > 0 ? 'low' : 'pass') +
        contractPill('PASS', s.pass ?? 0, 'pass') +
        contractPill('전체 기준', s.total ?? 0, 'pass') +
      '</div></div>';
    }
    function contractPill(label, value, tone) {
      return '<div class="qa-contract-pill"><b>' + esc(label) + '</b><span class="' + tone + '">' + esc(value) + '</span></div>';
    }
    function renderJudgementItems(row) {
      const items = row.qaJudgementItems || [];
      const visible = items.filter((item) => item.status !== 'PASS');
      const displayItems = visible.length ? visible : items.slice(0, 3);
      if (!displayItems.length) return '';
      const remaining = items.length > displayItems.length ? '<div class="qa-muted">나머지 ' + (items.length - displayItems.length) + '개 PASS/상세 기준은 전체 QA 판정 항목에서 확인</div>' : '';
      return '<div class="qa-block"><strong>QA 판정 항목</strong><div class="qa-judgement-list">' +
        displayItems.map((item) => renderJudgementCard(item)).join('') +
        '</div>' + remaining + '</div>';
    }
    function renderJudgementDetails(row) {
      const rows = row.qaJudgementItems || [];
      return '<details class="qa-details"><summary>전체 QA 판정 항목 (' + rows.length + ')</summary><ul class="qa-list">' +
        rows.map((item) => '<li>' + renderJudgementLine(item) + '</li>').join('') +
      '</ul></details>';
    }
    function renderJudgementCard(item) {
      const tone = item.status === 'PASS' ? 'pass' : ['BLOCKED', 'RULE_INVALID', 'SKIP'].includes(item.status) ? 'low' : 'fail';
      return '<div class="qa-judgement-card ' + tone + '">' + renderJudgementLine(item) + '</div>';
    }
    function renderJudgementLine(item) {
      if (!item || typeof item !== 'object') return esc(item || '');
      const status = item.status || '';
      const tone = status === 'PASS' ? 'pass' : ['BLOCKED', 'RULE_INVALID', 'SKIP'].includes(status) ? 'low' : 'fail';
      return '<div class="qa-status-line"><span class="contract-status ' + tone + '">' + esc(status) + '</span><span>' + esc(item.criterionName || item.label || item.message || item.criterionId || '항목') + '</span></div>' +
        '<div class="qa-judgement-fields">' +
          '<div><b>관찰 근거</b> ' + esc(item.observedEvidence || item.reason || '관찰 근거 미기록') + '</div>' +
          '<div><b>통과 기준</b> ' + esc(item.passCriteria || '통과 기준 미기록') + '</div>' +
          '<div><b>다음 조치</b> ' + esc(item.nextAction || '다음 조치 미기록') + '</div>' +
        '</div>';
    }
    function renderFindingDetails(title, findings) {
      if (!findings.length) return '';
      return '<details class="qa-details"><summary>' + esc(title) + ' (' + findings.length + ')</summary><ul class="qa-list">' + findings.map((finding) => '<li><strong>' + esc(finding.severity || '') + '</strong> ' + esc(finding.message || finding.code || '') + '</li>').join('') + '</ul></details>';
    }
    function renderTextDetails(title, items) {
      return '<details class="qa-details"><summary>' + esc(title) + '</summary><ul class="qa-list">' + items.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul></details>';
    }
    function badge(value) {
      const lower = String(value).toLowerCase();
      const tone = lower.includes('pass') || lower.includes('ready') ? 'pass' : lower.includes('low') || lower.includes('not_observed') ? 'low' : 'fail';
      return '<span class="badge ' + tone + '">' + esc(value) + '</span>';
    }
    function esc(value) {
      return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll(\"'\", '&#39;');
    }
    function formatKst(value) {
      if (!value || value === '-') return '없음';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(date) + ' KST';
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pollNow();
    });
    pollNow();
  </script>
</body>
</html>`;
}

async function readRequestJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function writeJson(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function writeHtml(response, html) {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
  });
  response.end(html);
}

async function serveFile(response, path) {
  try {
    await stat(path);
  } catch {
    writeJson(response, 404, { error: 'file not found' });
    return;
  }
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': contentType(path),
  });
  createReadStream(path).pipe(response);
}

async function serveReportRelative(response, baseDir, urlPath, routePrefix) {
  let relativePath = '';
  try {
    relativePath = decodeURIComponent(urlPath.slice(routePrefix.length));
  } catch {
    writeJson(response, 400, { error: 'bad artifact path' });
    return;
  }
  if (!relativePath || relativePath.includes('\0')) {
    writeJson(response, 404, { error: 'file not found' });
    return;
  }
  const root = resolve(baseDir);
  const filePath = resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}/`)) {
    writeJson(response, 403, { error: 'artifact path denied' });
    return;
  }
  return serveFile(response, filePath);
}

function contentType(path) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
  }[extname(path)] ?? 'application/octet-stream';
}

function validateTarget(input) {
  const target = resolve(input);
  if (!target.startsWith(`${allowedRoot}/Dragonout`)) {
    throw new Error(`target worktree is outside allowlist: ${target}`);
  }
  return target;
}

function validateReportDir(input) {
  const target = resolve(input);
  const allowed =
    target === defaultReportDir ||
    target.startsWith(`${defaultReportDir}/`) ||
    target === runnerRoot ||
    target.startsWith(`${runnerRoot}/`) ||
    target.startsWith(`${allowedRoot}/Dragonout`) ||
    target.startsWith(`${allowedRoot}/Dragonout-task-`) ||
    target.startsWith(`${allowedRoot}/QA-Dragonout/reports/`);
  if (!allowed) {
    throw new Error(`report dir is outside allowlist: ${target}`);
  }
  return target;
}

function ensureInside(baseDir, filePath) {
  const root = resolve(baseDir);
  const target = resolve(filePath);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error(`path is outside current report dir: ${target}`);
  }
}

function normalizeCalibrationProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('profile JSON object가 필요합니다.');
  }
  const knownCandidateIds = /^CAL-[SFG]\d{2}$/;
  const profile = {
    version: 2,
    round: typeof value.round === 'string' ? value.round : 'regression-core-v1',
    updated_at: new Date().toISOString(),
    accepted: normalizeIdArray(value.accepted, knownCandidateIds),
    rejected: normalizeIdArray(value.rejected, knownCandidateIds),
    needs_rewrite: normalizeStringMap(value.needs_rewrite, knownCandidateIds),
    deferred: normalizeStringMap(value.deferred, knownCandidateIds),
    notes: normalizeStringMap(value.notes, knownCandidateIds),
    rewrites: normalizeRewriteMap(value.rewrites, knownCandidateIds),
    learned_rules: normalizeLearnedRulesMap(value.learned_rules, knownCandidateIds),
    priority_overrides: normalizePriorityMap(value.priority_overrides, knownCandidateIds),
  };
  const accepted = new Set(profile.accepted);
  profile.rejected = profile.rejected.filter((id) => !accepted.has(id));
  for (const id of Object.keys(profile.needs_rewrite)) {
    if (accepted.has(id)) delete profile.needs_rewrite[id];
  }
  for (const id of Object.keys(profile.deferred)) {
    if (accepted.has(id)) delete profile.deferred[id];
  }
  return profile;
}

function normalizeIdArray(value, pattern) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((id) => id.trim()).filter((id) => pattern.test(id)))];
}

function normalizeStringMap(value, pattern) {
  if (Array.isArray(value)) {
    return Object.fromEntries(normalizeIdArray(value, pattern).map((id) => [id, '']));
  }
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([id, text]) => [String(id).trim(), String(text ?? '').trim()])
      .filter(([id]) => pattern.test(id)),
  );
}

function normalizePriorityMap(value, pattern) {
  const allowed = new Set(['P0', 'P1', 'P2', 'P3']);
  return Object.fromEntries(
    Object.entries(normalizeStringMap(value, pattern))
      .filter(([, priority]) => allowed.has(priority)),
  );
}

function normalizeRewriteMap(value, pattern) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [id, rewrite] of Object.entries(value)) {
    const candidateId = String(id).trim();
    if (!pattern.test(candidateId) || !rewrite || typeof rewrite !== 'object' || Array.isArray(rewrite)) continue;
    const fields = {};
    for (const field of ['title', 'evidence', 'problem_claim', 'suggested_fix']) {
      const text = String(rewrite[field] ?? '').trim();
      if (text) fields[field] = text;
    }
    if (Object.keys(fields).length > 0) result[candidateId] = fields;
  }
  return result;
}

function normalizeLearnedRulesMap(value, pattern) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [id, rules] of Object.entries(value)) {
    const candidateId = String(id).trim();
    if (!pattern.test(candidateId) || !Array.isArray(rules)) continue;
    const normalizedRules = rules
      .map((rule) => normalizeLearnedRule(rule, candidateId))
      .filter(Boolean);
    if (normalizedRules.length > 0) result[candidateId] = normalizedRules;
  }
  return result;
}

function normalizeLearnedRule(rule, candidateId) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const ruleId = String(rule.rule_id ?? '').trim();
  if (!/^[-a-z0-9_]+$/.test(ruleId)) return null;
  return {
    rule_id: ruleId,
    candidate_id: candidateId,
    assertion: String(rule.assertion ?? '').trim(),
    current_observation: String(rule.current_observation ?? '').trim(),
    pass_criteria: String(rule.pass_criteria ?? '').trim(),
    severity: ['P0', 'P1', 'P2', 'P3'].includes(rule.severity) ? rule.severity : 'P1',
    source: String(rule.source ?? 'user_calibrated').trim(),
  };
}

function splitLines(value) {
  return String(value).split(/[,\n]/).map((line) => line.trim()).filter(Boolean);
}

function trimOutput(value) {
  return String(value ?? '').slice(-4000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatKst(value) {
  if (!value) return '없음';
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

function nextActionForFailure(phase) {
  if (phase === 'lint') return '자동 검사 FAIL 화면을 수정한 뒤 Fast QA를 다시 실행하세요.';
  if (phase === 'capture') return '캡처 실패 원인을 확인하고 대상 화면 또는 Chrome 실행 조건을 수정하세요.';
  if (phase === 'validation') return '산출물 계약 오류를 수정한 뒤 Report만 갱신하거나 QA를 다시 실행하세요.';
  return '실패 단계의 로그를 확인하고 해당 단계를 다시 실행하세요.';
}

function serverSnippet(targetWorktree) {
  const webDir = join(targetWorktree, 'build/web');
  return `import('node:http').then(({createServer})=>import('node:fs').then(fs=>import('node:path').then(path=>{const root=${JSON.stringify(webDir)};const s=createServer((req,res)=>{let p=decodeURIComponent(new URL(req.url,'http://x').pathname);if(p==='/'||p==='')p='/index.html';const f=path.join(root,p);if(!f.startsWith(root)){res.writeHead(403);res.end();return;}fs.createReadStream(f).on('error',()=>{res.writeHead(404);res.end('not found')}).pipe(res)});s.listen(64618,'127.0.0.1')})))`;
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function ensureReportSeed() {
  await mkdir(currentReportDir, { recursive: true });
  const currentReport = join(currentReportDir, 'report.html');
  try {
    await stat(currentReport);
    return;
  } catch {
    // Seed from the compatibility report bundled in the QA runner worktree.
  }
  const seedDir = join(runnerRoot, 'docs/qa/reports/2026-05-09-ui-qa-pipeline');
  try {
    await cp(seedDir, currentReportDir, { recursive: true });
  } catch {
    await writeFile(currentReport, '<!doctype html><meta charset="utf-8"><p>QA report has not been generated yet.</p>');
  }
}

async function resetReportForRun(job) {
  await mkdir(job.reportDir, { recursive: true });
  for (const file of [
    'codex_product_review.json',
    'codex_playthrough_review.json',
    'polish_lints.json',
    'capture_result.json',
  ]) {
    await rm(join(job.reportDir, file), { force: true });
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
