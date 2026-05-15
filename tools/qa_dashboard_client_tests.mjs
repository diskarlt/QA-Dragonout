#!/usr/bin/env node

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const clientPath = 'tools/qa_dashboard_client.mjs';
const canonicalRunnerRoot = process.cwd();

await testCanonicalDelegation();
await testStaleActiveJobDoctor();
await testMissingRunner();
await testStaleServer();

console.log('qa_dashboard_client tests passed');

async function testCanonicalDelegation() {
  const port = 64881;
  let received = null;
  let scenarioReceived = null;
  const server = await startServer(port, async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/health') {
      return json(response, 200, {
        runnerRoot: canonicalRunnerRoot,
        isCanonicalRunner: true,
        dashboardVersion: 'calibration-readability-v1',
        reportDir: `${canonicalRunnerRoot}/reports/current`,
        pid: process.pid,
      });
    }
    if (request.method === 'POST' && request.url === '/api/run/fast') {
      received = await readJson(request);
      return json(response, 202, { job: { id: 'qa-test', mode: 'fast' } });
    }
    if (request.method === 'POST' && request.url === '/api/run/scenario') {
      scenarioReceived = await readJson(request);
      return json(response, 202, { job: { id: 'qa-scenario', mode: 'scenario' } });
    }
    if (request.method === 'GET' && request.url === '/api/status') {
      return json(response, 200, {
        defaults: { targetWorktree: '/Users/euna/Developer/Dragonout' },
        activeJob: null,
        lastJob: null,
      });
    }
    json(response, 404, { error: 'not found' });
  });
  try {
    const { stdout } = await runClient(port, ['fast', '--target', '/Users/euna/Developer/Dragonout-task-demo', '--changed-file', 'lib/main.dart']);
    const result = JSON.parse(stdout);
    assert(result.delegated === true, 'client delegates fast QA to central runner');
    assert(result.runnerRoot === canonicalRunnerRoot, 'client records canonical runner root');
    assert(received.targetWorktree === '/Users/euna/Developer/Dragonout-task-demo', 'client sends target worktree');
    assert(received.changedFiles === 'lib/main.dart', 'client sends changed files');

    const scenario = await runClient(port, [
      'scenario',
      '--target',
      '/Users/euna/Developer/Dragonout-task-demo',
      '--flow',
      'first_report_flow',
      '--screen',
      'result',
      '--device-profile',
      'mobile-sm',
      '--viewport',
      'tablet:768x1024',
    ]);
    const scenarioResult = JSON.parse(scenario.stdout);
    assert(scenarioResult.delegated === true, 'client delegates scenario QA to central runner');
    assert(scenarioReceived.targetWorktree === '/Users/euna/Developer/Dragonout-task-demo', 'scenario sends target worktree');
    assert(scenarioReceived.flows === 'first_report_flow', 'scenario sends flow filters');
    assert(scenarioReceived.screens === 'result', 'scenario sends screen filters');
    assert(scenarioReceived.deviceProfiles === 'mobile-sm\ntablet:768x1024', 'scenario sends device profiles');
  } finally {
    await closeServer(server);
  }
}

async function testStaleActiveJobDoctor() {
  const port = 64883;
  const server = await startServer(port, async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/health') {
      return json(response, 200, {
        runnerRoot: canonicalRunnerRoot,
        isCanonicalRunner: true,
        dashboardVersion: 'calibration-readability-v1',
        reportDir: `${canonicalRunnerRoot}/reports/current`,
        pid: process.pid,
      });
    }
    if (request.method === 'GET' && request.url === '/api/status') {
      return json(response, 200, {
        defaults: { targetWorktree: '/Users/euna/Developer/Dragonout' },
        activeJob: {
          id: 'qa-stale',
          mode: 'full',
          status: 'running',
          phase: 'capture',
          stale: true,
          staleMs: 120000,
          lastHeartbeatAt: '2026-05-14T00:00:00.000Z',
          childProgress: { phase: 'capture', message: 'Chrome screenshot capture' },
        },
        lastJob: null,
      });
    }
    json(response, 404, { error: 'not found' });
  });
  try {
    const result = await runClient(port, ['doctor'], false);
    assert(result.code !== 0, 'stale active job doctor returns non-zero');
    const body = JSON.parse(result.stdout);
    assert(body.status === 'stale_active_job', 'doctor flags stale active job');
    assert(body.activeJob?.id === 'qa-stale', 'doctor includes stale job snapshot');
  } finally {
    await closeServer(server);
  }
}

async function testMissingRunner() {
  const result = await runClient(64992, ['status'], false);
  assert(result.code !== 0, 'missing runner returns non-zero');
  assert(result.stderr.includes('중앙 QA runner 시작 필요'), 'missing runner explains central runner requirement');
}

async function testStaleServer() {
  const port = 64882;
  const server = await startServer(port, async (_request, response) => {
    json(response, 404, { error: 'not found' });
  });
  try {
    const result = await runClient(port, ['doctor'], false);
    assert(result.code !== 0, 'stale server doctor returns non-zero');
    const body = JSON.parse(result.stdout);
    assert(body.status === 'stale_or_noncanonical_server', 'doctor flags stale server');
    assert(body.portOwner?.pid, 'doctor includes port owner pid');
  } finally {
    await closeServer(server);
  }
}

async function runClient(port, args, requireOk = true) {
  try {
    const result = await execFileAsync(process.execPath, [clientPath, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        QA_DASHBOARD_URL: `http://127.0.0.1:${port}`,
        QA_CANONICAL_RUNNER_ROOT: canonicalRunnerRoot,
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (requireOk) throw error;
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

function startServer(port, handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

function json(response, status, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
