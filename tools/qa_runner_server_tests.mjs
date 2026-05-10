#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const port = 64871;
const tempRoot = await mkdtemp(join(tmpdir(), 'dragonout-qa-runner-test-'));
const reportDir = join(tempRoot, 'reports/current');
const screenshotDir = join(reportDir, 'screenshots');
const server = spawn(process.execPath, ['tools/qa_runner_server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    QA_DASHBOARD_PORT: String(port),
    QA_RUNNER_TEST_MODE: '1',
    QA_RUNNER_TEST_DELAY_MS: '800',
    QA_REPORT_DIR: reportDir,
    QA_SCREENSHOT_DIR: screenshotDir,
    QA_CANONICAL_RUNNER_ROOT: process.cwd(),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverStdout = '';
let serverStderr = '';
server.stdout.on('data', (chunk) => {
  serverStdout += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverStderr += chunk.toString();
});

try {
  await waitForServer(port);

  const status = await getJson('/api/status');
  assert(status.defaults.dashboardUrl === `http://127.0.0.1:${port}`, 'status returns dashboard url');
  assert(status.defaults.reportDir === reportDir, 'status returns central report dir');
  assert(status.defaults.runnerRoot === process.cwd(), 'status separates runner root from target worktree');
  assert(status.defaults.canonicalRunnerRoot === process.cwd(), 'status returns canonical runner root');
  assert(status.server.dashboardVersion === 'calibration-readability-v1', 'status exposes dashboard version');
  assert(status.server.runnerRoot === process.cwd(), 'status exposes runner root');
  assert(status.server.isCanonicalRunner === true, 'status confirms canonical runner');

  const health = await getJson('/api/health');
  assert(health.dashboardVersion === 'calibration-readability-v1', 'health exposes dashboard version');
  assert(health.runnerRoot === process.cwd(), 'health exposes runner root');
  assert(health.canonicalRunnerRoot === process.cwd(), 'health exposes canonical runner root');
  assert(health.isCanonicalRunner === true, 'health marks canonical runner');

  const dashboard = await getText('/');
  assert(dashboard.includes('Dashboard UI: calibration-readability-v1'), 'dashboard shows UI version');
  assert(dashboard.includes(process.cwd()), 'dashboard shows runner root');
  assert(dashboard.includes('Canonical:'), 'dashboard shows canonical runner root');
  assert(dashboard.includes('Target'), 'dashboard shows target worktree separately');
  assert(dashboard.includes('수정 큐로 이동'), 'dashboard links to inline queue section');
  assert(dashboard.includes('상세 HTML report'), 'dashboard labels standalone report separately');
  assert(dashboard.includes('/report'), 'dashboard contains report url');
  assert(!dashboard.includes('<iframe'), 'dashboard does not embed report iframe');
  assert(dashboard.includes('qaReportHost'), 'dashboard renders report inline host');
  assert(dashboard.includes('runBanner'), 'dashboard separates current run from report artifact');
  assert(dashboard.includes('/api/report-view'), 'dashboard renders inline report from report view API');
  assert(!dashboard.includes('attachShadow'), 'dashboard does not inject report.html through shadow DOM');
  assert(!dashboard.includes('prepareInlineReport'), 'dashboard does not reshape report tables client-side');
  assert(dashboard.includes('qa-item-grid'), 'dashboard includes card-based QA queue layout');
  assert(dashboard.includes('grid-template-columns: 1fr'), 'dashboard uses a single-column QA card queue');
  assert(dashboard.includes('qa-judgement-list'), 'dashboard renders a single QA judgement item list inside each card');
  assert(dashboard.includes('QA 판정 요약'), 'dashboard cards show judgement summary outside details');
  assert(dashboard.includes('전체 QA 판정 항목'), 'dashboard folds all judgement items into details');
  assert(dashboard.includes('PASS'), 'dashboard renders fixed PASS contract label');
  assert(dashboard.includes('FAIL'), 'dashboard renders fixed FAIL contract label');
  assert(dashboard.includes('LOW_CONFIDENCE'), 'dashboard renders fixed low-confidence judgement label');
  assert(!dashboard.includes('펼쳐진 실패 계약'), 'dashboard does not split visible contract failure blocks');
  assert(!dashboard.includes('펼쳐진 증거 부족 계약'), 'dashboard does not split visible evidence gap blocks');
  assert(dashboard.includes('overflow-x:hidden'), 'dashboard blocks horizontal page overflow');
  assert(dashboard.includes('Asia/Seoul'), 'dashboard formats visible QA times in KST');
  assert(dashboard.includes('pollDelayMs'), 'dashboard uses adaptive polling');
  assert(dashboard.includes('visibilitychange'), 'dashboard slows polling while hidden and refreshes when visible');
  assert(dashboard.includes('pollInFlight'), 'dashboard prevents overlapping status polls');
  assert(!dashboard.includes('setInterval(poll'), 'dashboard does not use fixed interval polling');

  const reportView = await getJson('/api/report-view');
  assert(Array.isArray(reportView.screens), 'report view returns screen rows');
  assert(reportView.screens.length > 0, 'report view includes screens');
  assert(reportView.screens[0].verdict, 'report view screen rows include verdict');
  assert(reportView.screens[0].primaryFailure, 'report view screen rows include primary failure');
  assert(reportView.screens[0].recommendedFix, 'report view screen rows include recommended fix');
  assert(reportView.screens[0].screenshot?.startsWith('/screenshots/'), 'report view uses served screenshot URLs');
  assert(reportView.reportStat?.mtimeKst?.includes('KST'), 'report view exposes KST report time');
  assert(Array.isArray(reportView.screens[0].contractPasses), 'report view includes passed contract rows');
  assert(Array.isArray(reportView.screens[0].forbiddenAbsences), 'report view includes forbidden absence rows');
  assert(reportView.screens[0].contractSummary?.total >= 0, 'report view includes contract summary');
  assert(Array.isArray(reportView.screens[0].contractRows), 'report view includes full contract rows');
  assert(Array.isArray(reportView.screens[0].qaJudgementItems), 'report view includes unified judgement items');
  assert(reportView.screens[0].qaJudgementSummary?.total >= 0, 'report view includes judgement summary');
  const firstJudgement = reportView.screens[0].qaJudgementItems[0];
  assert(firstJudgement?.status, 'judgement item includes fixed status');
  assert(firstJudgement.observedEvidence, 'judgement item includes observed evidence');
  assert(firstJudgement.passCriteria, 'judgement item includes pass criteria');
  assert(firstJudgement.nextAction, 'judgement item includes next action');
  assert(!['기대 항목 미충족', '구현 증거 부족'].includes(firstJudgement.observedEvidence), 'judgement item does not expose generic reason');

  const calibrationProfile = await getJson('/api/calibration-profile');
  assert(calibrationProfile.profilePath === join(reportDir, 'qa_calibration_profile.json'), 'calibration profile API uses current report dir');
  const saveProfile = await postJson('/api/calibration-profile', {
    profilePath: '/tmp/dragonout-should-not-write.json',
    accepted: ['CAL-S02'],
    learned_rules: {
      'CAL-S02': [
        {
          rule_id: 'guardian_portrait_scale_consistency',
          assertion: '거점 가디언 초상화는 카드 사이 얼굴 비율이 일관되지 않으면 FAIL이다.',
          current_observation: '서버 테스트 fixture에서 CAL-S02 학습 규칙 저장을 확인한다.',
          pass_criteria: '모든 가디언 카드의 얼굴 크기와 기준선이 같은 portrait spec 안에 들어와야 한다.',
          severity: 'P0',
          source: 'server_test',
        },
      ],
    },
  });
  assert(saveProfile.status === 200, 'calibration profile POST succeeds');
  assert(saveProfile.json.profilePath === join(reportDir, 'qa_calibration_profile.json'), 'calibration profile POST ignores caller-supplied paths');
  const savedProfile = await getJson('/api/calibration-profile');
  assert(savedProfile.profile.accepted.includes('CAL-S02'), 'calibration profile POST stores accepted candidate');
  const refreshedReportHtml = await getText('/report');
  assert(refreshedReportHtml.includes('guardian_portrait_scale_consistency'), 'profile POST refreshes report with learned rule');
  assert(!refreshedReportHtml.includes('캘리브레이션 후보표'), 'normal report hides calibration candidate table');
  const calibrationSetupHtml = await getText('/calibration');
  assert(calibrationSetupHtml.includes('Dragonout QA 허들 설정'), 'calibration setup route serves separate setup report');

  await writeFile(join(screenshotDir, 'server_test.png'), pngFixture());
  const screenshot = await fetch(`http://127.0.0.1:${port}/screenshots/server_test.png`);
  assert(screenshot.status === 200, 'screenshot route returns 200');
  assert(screenshot.headers.get('content-type') === 'image/png', 'screenshot route returns image/png');

  const missingScreenshot = await fetch(`http://127.0.0.1:${port}/screenshots/missing.png`);
  assert(missingScreenshot.status === 404, 'missing screenshot returns 404');

  const traversal = await fetch(`http://127.0.0.1:${port}/screenshots/%2e%2e/qa_live_status.json`);
  assert([403, 404].includes(traversal.status), 'screenshot traversal is denied');

  const invalid = await postJson('/api/run/fast', { targetWorktree: '/tmp/not-dragonout' }, false);
  assert(invalid.status === 400, 'allowlist rejects target outside Dragonout roots');

  const fast = await postJson('/api/run/fast', {
    targetWorktree: '/Users/euna/Developer/Dragonout',
    changedFiles: 'lib/main.dart\nlib/widgets/game_widgets.dart',
  });
  assert(fast.status === 202, 'fast QA starts');
  assert(fast.json.job.mode === 'fast', 'fast QA job mode is recorded');

  const duplicate = await postJson('/api/run/full', {
    targetWorktree: '/Users/euna/Developer/Dragonout',
  }, false);
  assert(duplicate.status === 409, 'duplicate job is rejected while running');

  const cancel = await postJson('/api/cancel');
  assert(cancel.json.cancelled === true, 'cancel stops active job');

  await waitFor(
    () => getJson('/api/status').then((body) => body.lastJob?.status === 'cancelled'),
    4000,
  );

  const refresh = await postJson('/api/refresh-report', {
    targetWorktree: '/Users/euna/Developer/Dragonout',
  });
  assert(refresh.status === 202, 'refresh report job starts');
  await waitFor(() => getJson('/api/status').then((body) => body.lastJob?.status === 'complete'), 4000);

  const reports = await getJson('/api/reports/current');
  assert(reports.reportStat?.size > 0, 'report metadata is available');
  assert(reports.screenshotStats?.count > 0, 'screenshot metadata is available');
  assert(reports.reportStat?.mtime !== status.report.reportStat?.mtime, 'report mtime changes after refresh');

  console.log('qa_runner_server tests passed');
} finally {
  server.kill('SIGTERM');
  await rm(tempRoot, { recursive: true, force: true });
}

async function getJson(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function getText(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${text}`);
  }
  return text;
}

async function postJson(path, body = {}, requireOk = true) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (requireOk && !response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return { status: response.status, json };
}

async function waitForServer() {
  await waitFor(async () => {
    if (server.exitCode !== null) {
      throw new Error(`server exited early (${server.exitCode})\n${serverStdout}\n${serverStderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      return response.ok;
    } catch {
      return false;
    }
  }, 5000);
}

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await sleep(80);
  }
  throw new Error('timed out waiting for condition');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pngFixture() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFgwJ/lYg8WQAAAABJRU5ErkJggg==',
    'base64',
  );
}
