#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const dashboardUrl = (process.env.QA_DASHBOARD_URL ?? 'http://127.0.0.1:64700').replace(/\/$/, '');
const canonicalRunnerRoot = resolve(process.env.QA_CANONICAL_RUNNER_ROOT ?? '/Users/euna/Developer/QA-Dragonout');
const command = process.argv[2] ?? 'status';
const args = process.argv.slice(3);

const options = parseArgs(args);

try {
  if (command === 'doctor') {
    await doctor();
  } else if (command === 'status') {
    await status();
  } else if (command === 'fast' || command === 'full' || command === 'scenario' || command === 'refresh') {
    await run(command);
  } else if (command === 'open') {
    console.log(dashboardUrl);
  } else {
    usage(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function status() {
  const health = await requireCanonicalRunner();
  const statusPayload = await getJson('/api/status');
  console.log(JSON.stringify({
    ok: true,
    dashboardUrl,
    runnerRoot: health.runnerRoot,
    targetWorktree: statusPayload.defaults?.targetWorktree,
    reportDir: health.reportDir,
    activeJob: statusPayload.activeJob,
    lastJob: statusPayload.lastJob,
  }, null, 2));
}

async function run(mode) {
  const health = await requireCanonicalRunner();
  const endpoint = mode === 'refresh' ? '/api/refresh-report' : `/api/run/${mode}`;
  const targetWorktree = resolve(options.target ?? process.cwd());
  validateTarget(targetWorktree);
  const changedFiles = options.changedFiles ?? '';
  const response = await postJson(endpoint, {
    targetWorktree,
    changedFiles,
    flows: options.flows ?? '',
    screens: options.screens ?? '',
    deviceProfiles: options.deviceProfiles ?? '',
  });
  console.log(JSON.stringify({
    ok: true,
    delegated: true,
    dashboardUrl,
    runnerRoot: health.runnerRoot,
    targetWorktree,
    job: response.job,
  }, null, 2));
}

async function doctor() {
  const health = await tryGetHealth();
  if (isCanonicalHealth(health)) {
    const statusPayload = await getJson('/api/status').catch(() => null);
    if (statusPayload?.activeJob?.stale) {
      console.log(JSON.stringify({
        ok: false,
        status: 'stale_active_job',
        dashboardUrl,
        runnerRoot: health.runnerRoot,
        pid: health.pid,
        reportDir: health.reportDir,
        activeJob: statusPayload.activeJob,
        nextAction: 'activeJob.lastHeartbeatAt과 childProgress를 확인하고, 필요하면 /api/cancel 또는 runner 재시작으로 하위 프로세스를 정리하세요.',
      }, null, 2));
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify({
      ok: true,
      status: 'canonical_runner_active',
      dashboardUrl,
      runnerRoot: health.runnerRoot,
      pid: health.pid,
      reportDir: health.reportDir,
    }, null, 2));
    return;
  }

  const owner = await portOwner();
  console.log(JSON.stringify({
    ok: false,
    status: owner ? 'stale_or_noncanonical_server' : 'runner_not_running',
    dashboardUrl,
    expectedRunnerRoot: canonicalRunnerRoot,
    observedHealth: health,
    portOwner: owner,
    nextAction: owner
      ? '잘못된 QA 서버가 포트를 점유 중입니다. PID를 확인한 뒤 승인받아 종료하고 중앙 runner를 시작하세요.'
      : `중앙 QA runner를 시작하세요: cd ${canonicalRunnerRoot} && node tools/qa_runner_server.mjs`,
  }, null, 2));
  process.exitCode = 1;
}

async function requireCanonicalRunner() {
  const health = await tryGetHealth();
  if (isCanonicalHealth(health)) return health;
  const owner = await portOwner();
  const detail = owner
    ? `현재 포트 점유: PID ${owner.pid}, cwd ${owner.cwd ?? 'unknown'}`
    : '현재 64700 포트에 응답하는 QA runner가 없습니다.';
  throw new Error([
    '중앙 QA runner 시작 필요 또는 stale server 점유 상태입니다.',
    `expected runner: ${canonicalRunnerRoot}`,
    detail,
    `진단: node ${canonicalRunnerRoot}/tools/qa_dashboard_client.mjs doctor`,
  ].join('\n'));
}

async function tryGetHealth() {
  try {
    return await getJson('/api/health');
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function isCanonicalHealth(health) {
  return Boolean(
    health
      && health.runnerRoot
      && resolve(health.runnerRoot) === canonicalRunnerRoot
      && health.isCanonicalRunner !== false,
  );
}

async function getJson(path) {
  return requestJson('GET', path);
}

async function postJson(path, body) {
  return requestJson('POST', path, body);
}

async function requestJson(method, path, body = null) {
  const url = `${dashboardUrl}${path}`;
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    return parseResponseJson(path, response.status, response.ok, await response.text());
  } catch (error) {
    if (!isLocalNetworkDenied(error)) throw error;
    return requestJsonWithCurl(method, path, body);
  }
}

async function requestJsonWithCurl(method, path, body = null) {
  const curlArgs = ['--silent', '--show-error', '--max-time', '5', '--write-out', '\n%{http_code}', '--request', method];
  if (body) {
    curlArgs.push('--header', 'content-type: application/json', '--data', JSON.stringify(body));
  }
  curlArgs.push(`${dashboardUrl}${path}`);
  const { stdout } = await execFileAsync('curl', curlArgs);
  const splitAt = stdout.lastIndexOf('\n');
  const text = splitAt >= 0 ? stdout.slice(0, splitAt) : stdout;
  const status = Number(splitAt >= 0 ? stdout.slice(splitAt + 1) : 0);
  return parseResponseJson(path, status, status >= 200 && status < 300, text);
}

function parseResponseJson(path, status, ok, text) {
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} returned non-JSON response (${status})`);
  }
  if (!ok) {
    throw new Error(`${path} failed (${status}): ${json?.error ?? JSON.stringify(json)}`);
  }
  return json;
}

function isLocalNetworkDenied(error) {
  const code = error?.cause?.code ?? error?.code;
  return code === 'EPERM' || code === 'EACCES';
}

async function portOwner() {
  const url = new URL(dashboardUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
    const pid = stdout.split('\n').find((line) => line.startsWith('p'))?.slice(1);
    if (!pid) return null;
    let cwd = null;
    try {
      const { stdout: cwdOutput } = await execFileAsync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']);
      cwd = cwdOutput.split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? null;
    } catch {
      cwd = null;
    }
    return { pid, cwd };
  } catch {
    return null;
  }
}

function parseArgs(rawArgs) {
  const parsed = { target: null, changedFiles: '', flows: '', screens: '', deviceProfiles: '' };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--target') {
      parsed.target = rawArgs[++index];
    } else if (arg === '--changed-files') {
      parsed.changedFiles = rawArgs[++index] ?? '';
    } else if (arg === '--changed-file') {
      parsed.changedFiles = [parsed.changedFiles, rawArgs[++index] ?? ''].filter(Boolean).join('\n');
    } else if (arg === '--flow') {
      parsed.flows = [parsed.flows, rawArgs[++index] ?? ''].filter(Boolean).join('\n');
    } else if (arg === '--flows') {
      parsed.flows = rawArgs[++index] ?? '';
    } else if (arg === '--screen') {
      parsed.screens = [parsed.screens, rawArgs[++index] ?? ''].filter(Boolean).join('\n');
    } else if (arg === '--screens') {
      parsed.screens = rawArgs[++index] ?? '';
    } else if (arg === '--device-profile') {
      parsed.deviceProfiles = [parsed.deviceProfiles, rawArgs[++index] ?? ''].filter(Boolean).join('\n');
    } else if (arg === '--devices' || arg === '--viewports') {
      parsed.deviceProfiles = rawArgs[++index] ?? '';
    } else if (arg === '--viewport') {
      parsed.deviceProfiles = [parsed.deviceProfiles, rawArgs[++index] ?? ''].filter(Boolean).join('\n');
    } else if (arg === '--help' || arg === '-h') {
      usage(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function validateTarget(targetWorktree) {
  if (!targetWorktree.startsWith('/Users/euna/Developer/Dragonout')) {
    throw new Error(`target worktree is outside allowlist: ${targetWorktree}`);
  }
}

function usage(code) {
  console.log([
    'Usage: node tools/qa_dashboard_client.mjs <status|doctor|fast|full|scenario|refresh|open> [options]',
    '',
    'Options:',
    '  --target <path>            Dragonout target worktree. Default: current working directory.',
    '  --changed-files <text>     Newline/comma separated changed files for Fast QA.',
    '  --changed-file <path>      Add one changed file. Can be repeated.',
    '  --flow <id>                Scenario QA flow id. Can be repeated.',
    '  --screen <id>              Scenario QA screen id. Can be repeated.',
    '  --device-profile <name>    Scenario device profile. Can be repeated.',
    '  --viewport <WxH|id:WxH>    Scenario custom viewport. Can be repeated.',
  ].join('\n'));
  process.exit(code);
}
