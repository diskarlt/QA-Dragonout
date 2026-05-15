#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

class CdpClient {
  static connect(url) {
    return new Promise((resolveClient, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolveClient(new CdpClient(ws)));
      ws.addEventListener('error', reject);
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve: resolveCall, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolveCall(message.result);
      }
    });
  }

  send(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCall, reject, timer });
      this.ws.send(payload);
    });
  }

  close() {
    this.ws.close();
  }
}

const DEVICE_PRESETS = new Map([
  ['mobile-sm', { id: 'mobile-sm', label: 'Mobile small', width: 360, height: 740, deviceScaleFactor: 1, mobile: true }],
  ['iphone-se', { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, deviceScaleFactor: 1, mobile: true }],
  ['mobile-md', { id: 'mobile-md', label: 'Mobile medium', width: 390, height: 844, deviceScaleFactor: 1, mobile: true }],
  ['mobile-lg', { id: 'mobile-lg', label: 'Mobile large', width: 430, height: 932, deviceScaleFactor: 1, mobile: true }],
  ['tablet', { id: 'tablet', label: 'Tablet portrait', width: 768, height: 1024, deviceScaleFactor: 1, mobile: true }],
  ['desktop', { id: 'desktop', label: 'Desktop', width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }],
]);

const chromePath =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = process.env.QA_BASE_URL ?? 'http://127.0.0.1:64618';
const reportDir = resolve(process.env.QA_REPORT_DIR ?? 'reports/current');
const artifactRoot = resolve(process.env.QA_SCENARIO_ARTIFACTS_DIR ?? join(reportDir, 'scenario_artifacts'));
const matrixPath = process.env.QA_MATRIX_PATH ?? 'tools/qa_matrix.json';
const playthroughMatrixPath =
  process.env.QA_PLAYTHROUGH_MATRIX_PATH ?? 'tools/qa_playthrough_matrix.json';
const outputPath = process.env.QA_SCENARIO_ARTIFACTS_PATH ?? join(reportDir, 'scenario_artifacts.json');
const requestedFlows = parseCsv(process.env.QA_SCENARIO_FLOW ?? process.env.QA_SCENARIO_FLOWS);
const requestedScreens = parseCsv(process.env.QA_SCENARIO_SCREEN ?? process.env.QA_SCENARIO_SCREENS);
const requestedGroups = parseCsv(process.env.QA_SCENARIO_GROUP ?? process.env.QA_SCENARIO_GROUPS);
const deviceProfiles = parseDeviceProfiles(
  process.env.QA_DEVICE_PROFILES ?? process.env.QA_VIEWPORTS ?? 'mobile-sm,mobile-md,mobile-lg,tablet',
);
const liveReport = process.env.QA_LIVE_REPORT === '1';
const port = Number(process.env.QA_SCENARIO_DEBUG_PORT ?? process.env.QA_DEBUG_PORT ?? 9555);
const headless = process.env.QA_HEADLESS !== '0';
const startedAt = new Date().toISOString();

const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
const playthroughMatrix = JSON.parse(await readFile(playthroughMatrixPath, 'utf8'));
const screenById = new Map((matrix.screens ?? []).map((screen) => [screen.id, screen]));
const scenarioFlows = selectScenarioFlows();
const totalSteps = scenarioFlows.reduce((sum, flow) => sum + flow.steps.length, 0) * deviceProfiles.length;
const userDataDir = await mkdtemp(join(tmpdir(), 'dragonout-scenario-cdp-profile-'));
const maxWidth = Math.max(...deviceProfiles.map((profile) => profile.width));
const maxHeight = Math.max(...deviceProfiles.map((profile) => profile.height));
const chromeArgs = [
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-component-update',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--disable-logging',
  '--log-level=3',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  `--window-size=${maxWidth},${maxHeight}`,
  'about:blank',
];
if (headless) chromeArgs.unshift('--headless=new');

await mkdir(artifactRoot, { recursive: true });
const chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore' });
let completed = 0;
let shutdownInProgress = false;
const aggregateFlows = [];

process.once('SIGTERM', () => {
  shutdownAfterSignal('SIGTERM').catch(() => process.exit(130));
});
process.once('SIGINT', () => {
  shutdownAfterSignal('SIGINT').catch(() => process.exit(130));
});

try {
  await waitForDebugger();
  updateLiveReport('running', 'scenario-capture', `시나리오 캡처 시작: ${scenarioFlows.length}개 흐름, ${deviceProfiles.length}개 기기`, 0, totalSteps);
  for (const flow of scenarioFlows) {
    const flowEntry = {
      flow_id: flow.id,
      title: flow.title ?? flow.id,
      fastQaGroup: flow.fastQaGroup ?? null,
      sourceScreens: flow.steps,
      devices: [],
    };
    for (const device of deviceProfiles) {
      const deviceEntry = {
        device,
        viewport: viewportForDevice(device),
        steps: [],
      };
      for (let index = 0; index < flow.steps.length; index += 1) {
        const screen = screenById.get(flow.steps[index]);
        const stepArtifact = await captureScenarioStep(flow, screen, index, device).catch((error) =>
          failedStepArtifact(flow, screen, index, device, error),
        );
        completed += 1;
        deviceEntry.steps.push(stepArtifact);
        updateLiveReport(
          'running',
          'scenario-capture',
          `${flow.id}/${device.id}: ${screen?.id ?? flow.steps[index]} ${stepArtifact.status}`,
          completed,
          totalSteps,
        );
      }
      deviceEntry.status = statusFromChildren(deviceEntry.steps);
      flowEntry.devices.push(deviceEntry);
    }
    flowEntry.status = statusFromChildren(flowEntry.devices);
    aggregateFlows.push(flowEntry);
    await writeJson(join(artifactRoot, `${safeSegment(flow.id)}.json`), flowEntry);
  }
} finally {
  chrome.kill('SIGTERM');
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  await writeAggregate().catch(() => {});
  updateLiveReport('running', 'scenario-capture', `시나리오 캡처 결과 저장: ${completed}/${totalSteps}`, completed, totalSteps);
}

async function captureScenarioStep(flow, screen, index, device) {
  if (!screen) {
    throw new Error(`unknown screen in flow ${flow.id}: ${flow.steps[index]}`);
  }
  const stepNumber = String(index + 1).padStart(2, '0');
  const deviceDir = join(artifactRoot, safeSegment(flow.id), safeSegment(device.id));
  await mkdir(deviceDir, { recursive: true });
  const fileName = `${stepNumber}__${safeSegment(screen.id)}.png`;
  const screenshotPath = join(deviceDir, fileName);
  const route = `/?qaScreen=${encodeURIComponent(screen.qaScreen)}`;
  const page = await createPage();
  const client = await CdpClient.connect(page.webSocketDebuggerUrl);
  try {
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.deviceScaleFactor,
      mobile: device.mobile,
    });
    await client.send('Page.navigate', { url: `${baseUrl}${route}` });
    await sleep(screen.waitMs ?? 4500);
    await enableFlutterAccessibility(client).catch(() => null);
    await sleep(300);
    if (Number(screen.wheelY ?? 0) > 0) {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(device.width / 2),
        y: Math.round(device.height / 2),
        deltaX: 0,
        deltaY: Number(screen.wheelY),
      });
      await sleep(900);
    }
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 20000);
    await writeFile(screenshotPath, screenshot.data, 'base64');
    const fileStat = await stat(screenshotPath);
    const domMeta = await captureScenarioDomMeta(client).catch((error) => ({ error: error.message }));
    const artifact = buildStepArtifact({
      flow,
      screen,
      index,
      device,
      route,
      screenshotPath,
      fileStat,
      domMeta,
    });
    await writeJson(join(deviceDir, `${stepNumber}__${safeSegment(screen.id)}.json`), artifact);
    console.log(`${flow.id}/${device.id}/${screen.id} -> ${relativeReportPath(screenshotPath)}`);
    return artifact;
  } finally {
    client.close();
    await closePage(page.id).catch(() => {});
  }
}

function buildStepArtifact({ flow, screen, index, device, route, screenshotPath, fileStat, domMeta }) {
  const visibleText = normalizeTextArray(domMeta?.visibleText);
  const dialogueLines = dialogueLinesFromMeta(domMeta, visibleText);
  const primaryCtas = Array.isArray(domMeta?.primaryCtas) ? domMeta.primaryCtas : [];
  const imageNodes = Array.isArray(domMeta?.imageNodes) ? domMeta.imageNodes : [];
  const qaSnapshot = domMeta?.qaSnapshot ?? null;
  const visualSubjects = [
    ...(Array.isArray(qaSnapshot?.visualSubjects) ? qaSnapshot.visualSubjects : []),
    ...(Array.isArray(qaSnapshot?.sceneContract?.visualSubjects) ? qaSnapshot.sceneContract.visualSubjects : []),
  ];
  const renderedGuardians = Array.isArray(qaSnapshot?.guardians) ? qaSnapshot.guardians : [];
  const renderedLocations = Array.isArray(qaSnapshot?.locations) ? qaSnapshot.locations : [];
  const brokenImages = imageNodes.filter((image) => image.complete === false || Number(image.naturalWidth ?? 0) === 0 || Number(image.naturalHeight ?? 0) === 0);
  const missingEvidence = [];
  if (visibleText.length === 0) missingEvidence.push('visibleText 없음 — canvas-only 화면이면 screenshot 확대 검토 필요');
  if (dialogueLines.length === 0) missingEvidence.push('대사 후보 없음 — 화면 문구 또는 QA snapshot dialogue metadata 확인 필요');
  if (brokenImages.length > 0) missingEvidence.push(`broken img element ${brokenImages.length}건`);
  if (
    imageNodes.length === 0 &&
    visualSubjects.length === 0 &&
    renderedGuardians.length === 0 &&
    (screen.facets ?? []).some((facet) => ['visual', 'guardian_presence', 'guardian_portrait', 'location'].includes(facet))
  ) {
    missingEvidence.push('이미지/visual subject metadata 없음 — bitmap 표시 여부는 screenshot으로 직접 확인 필요');
  }

  return {
    flow_id: flow.id,
    step_id: `${flow.id}.${index}`,
    step_index: index,
    screen: screen.id,
    screenName: screen.screen,
    stage: screen.state,
    qaScreen: screen.qaScreen,
    route,
    device: device.id,
    viewport: viewportForDevice(device),
    screenshot: relativeReportPath(screenshotPath),
    status: missingEvidence.length === 0 ? 'captured' : 'partial',
    captured_at: new Date().toISOString(),
    bytes: fileStat.size,
    visibleText,
    dialogueLines,
    primaryCtas,
    disabledChoices: primaryCtas.filter((cta) => cta.enabled === false),
    imageEvidence: {
      imageNodeCount: imageNodes.length,
      brokenImageCount: brokenImages.length,
      visualSubjectCount: visualSubjects.length,
      guardianCount: renderedGuardians.length,
      locationCount: renderedLocations.length,
      imageNodes,
      visualSubjects,
      renderedGuardians,
      renderedLocations,
    },
    gameState: qaSnapshot?.gameState ?? null,
    sceneContract: qaSnapshot?.sceneContract ?? null,
    missingEvidence,
    source: domMeta?.qaSnapshot ? ['captureScenarioDomMeta', 'window.__QA_SNAPSHOT__'] : ['captureScenarioDomMeta'],
  };
}

function failedStepArtifact(flow, screen, index, device, error) {
  return {
    flow_id: flow.id,
    step_id: `${flow.id}.${index}`,
    step_index: index,
    screen: screen?.id ?? flow.steps[index],
    screenName: screen?.screen ?? null,
    stage: screen?.state ?? null,
    qaScreen: screen?.qaScreen ?? null,
    route: screen?.qaScreen ? `/?qaScreen=${encodeURIComponent(screen.qaScreen)}` : null,
    device: device.id,
    viewport: viewportForDevice(device),
    screenshot: null,
    status: 'failed',
    captured_at: new Date().toISOString(),
    visibleText: [],
    dialogueLines: [],
    primaryCtas: [],
    disabledChoices: [],
    imageEvidence: {
      imageNodeCount: 0,
      brokenImageCount: 0,
      visualSubjectCount: 0,
      guardianCount: 0,
      locationCount: 0,
      imageNodes: [],
      visualSubjects: [],
      renderedGuardians: [],
      renderedLocations: [],
    },
    gameState: null,
    sceneContract: null,
    missingEvidence: [error instanceof Error ? error.message : String(error)],
    source: ['capture_failed'],
  };
}

async function captureScenarioDomMeta(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: `
      (() => {
        const visibleText = (document.body?.innerText ?? '')
          .split('\\n').map(s => s.trim()).filter(Boolean).slice(0, 260);
        const primaryCtas = [...document.querySelectorAll('button,[role="button"],[role="link"],a')]
          .slice(0, 40)
          .map(el => {
            const rect = el.getBoundingClientRect();
            const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
            const label = (
              el.textContent?.trim() ||
              el.getAttribute('aria-label') ||
              el.getAttribute('title') ||
              ''
            ).replace(/\\s+/g, ' ').slice(0, 120);
            return {
              label,
              enabled: !disabled,
              action: el.getAttribute('data-action') ?? el.getAttribute('href') ?? el.getAttribute('data-route') ?? null,
              bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
              disabledReason: disabled ? (el.getAttribute('data-disabled-reason') ?? el.getAttribute('aria-describedby') ?? null) : null,
            };
          })
          .filter(cta => cta.label || cta.action);
        const imageNodes = [...document.querySelectorAll('img')]
          .slice(0, 80)
          .map(el => {
            const rect = el.getBoundingClientRect();
            return {
              src: el.currentSrc || el.src || el.getAttribute('src') || '',
              alt: el.getAttribute('alt') ?? '',
              complete: el.complete,
              naturalWidth: el.naturalWidth,
              naturalHeight: el.naturalHeight,
              bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
              visible: rect.width > 0 && rect.height > 0,
            };
          });
        const semanticNodes = [...document.querySelectorAll('[aria-label],[role],button,a,flt-semantics')]
          .slice(0, 260)
          .map(el => {
            const rect = el.getBoundingClientRect();
            const label = (
              el.getAttribute('aria-label') ??
              el.getAttribute('title') ??
              el.textContent ??
              ''
            ).trim().replace(/\\s+/g, ' ').slice(0, 140);
            return {
              label,
              role: el.getAttribute('role') ?? (el.tagName === 'BUTTON' ? 'button' : el.tagName.toLowerCase()),
              bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
              visible: rect.width > 0 && rect.height > 0,
            };
          })
          .filter(node => node.label && node.label !== 'Enable accessibility');
        const qaSnapshot = window.__QA_SNAPSHOT__ ?? null;
        return { visibleText, primaryCtas, imageNodes, semanticNodes, qaSnapshot };
      })()
    `,
    returnByValue: true,
    timeout: 5000,
  });
  return result?.result?.value ?? null;
}

async function enableFlutterAccessibility(client) {
  await client.send('Runtime.evaluate', {
    expression: `
      (() => {
        const candidates = [...document.querySelectorAll('[aria-label="Enable accessibility"], button, [role="button"]')];
        const target = candidates.find(el => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() === 'Enable accessibility');
        if (!target) return { enabled: false, reason: 'button_not_found' };
        target.click();
        return { enabled: true };
      })()
    `,
    returnByValue: true,
    timeout: 3000,
  });
}

function selectScenarioFlows() {
  const flowFilter = new Set(requestedFlows);
  const screenFilter = new Set(requestedScreens);
  const groupFilter = new Set(requestedGroups);
  let flows = (playthroughMatrix.flows ?? []).filter((flow) => {
    if (flowFilter.size > 0 && !flowFilter.has(flow.id)) return false;
    if (groupFilter.size > 0 && !groupFilter.has(flow.fastQaGroup)) return false;
    return true;
  });
  if (requestedScreens.length > 0 && flowFilter.size === 0 && groupFilter.size === 0) {
    flows = [{
      id: 'screen_scan',
      title: '화면 단위 재현 스캔',
      fastQaGroup: 'screen_scan',
      steps: requestedScreens,
      riskTags: ['scenario', 'visual'],
    }];
  } else if (screenFilter.size > 0) {
    flows = flows
      .map((flow) => ({ ...flow, steps: (flow.steps ?? []).filter((screenId) => screenFilter.has(screenId)) }))
      .filter((flow) => flow.steps.length > 0);
  }
  flows = flows
    .map((flow) => ({ ...flow, steps: (flow.steps ?? []).filter((screenId) => screenById.has(screenId)) }))
    .filter((flow) => flow.steps.length > 0);
  if (flows.length === 0) {
    const filters = [
      requestedFlows.length > 0 ? `flows=${requestedFlows.join(',')}` : null,
      requestedScreens.length > 0 ? `screens=${requestedScreens.join(',')}` : null,
      requestedGroups.length > 0 ? `groups=${requestedGroups.join(',')}` : null,
    ].filter(Boolean).join(' ');
    throw new Error(`scenario flow selection is empty (${filters || 'no filters'})`);
  }
  return flows;
}

function parseDeviceProfiles(value) {
  const tokens = parseCsv(value);
  const profiles = (tokens.length > 0 ? tokens : ['mobile-sm', 'mobile-md', 'mobile-lg', 'tablet'])
    .map((token) => deviceProfileFromToken(token));
  const seen = new Set();
  return profiles.filter((profile) => {
    if (seen.has(profile.id)) return false;
    seen.add(profile.id);
    return true;
  });
}

function deviceProfileFromToken(token) {
  const preset = DEVICE_PRESETS.get(token);
  if (preset) return preset;
  const match = token.match(/^(?:(?<id>[a-z0-9_-]+):)?(?<width>\d+)x(?<height>\d+)(?:@(?<scale>\d+(?:\.\d+)?))?$/i);
  if (!match?.groups) {
    throw new Error(`invalid device profile: ${token}`);
  }
  const width = Number(match.groups.width);
  const height = Number(match.groups.height);
  const id = match.groups.id ?? `${width}x${height}`;
  return {
    id,
    label: id,
    width,
    height,
    deviceScaleFactor: Number(match.groups.scale ?? 1),
    mobile: width < 900,
  };
}

function dialogueLinesFromMeta(domMeta, visibleText) {
  const snap = domMeta?.qaSnapshot ?? null;
  const candidates = [
    snap?.dialogueLines,
    snap?.dialogue,
    snap?.dialogues,
    snap?.transcript,
    snap?.sceneContract?.dialogueLines,
    snap?.sceneContract?.dialogue,
  ];
  for (const candidate of candidates) {
    const lines = normalizeTextArray(candidate);
    if (lines.length > 0) return lines.slice(0, 40);
  }
  const semanticLines = normalizeTextArray(domMeta?.semanticNodes?.map((node) => node.label));
  const combined = normalizeTextArray([...visibleText, ...semanticLines]);
  return combined.slice(0, 16);
}

function normalizeTextArray(value) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const result = [];
  const seen = new Set();
  for (const item of raw) {
    const text = typeof item === 'string'
      ? item
      : item?.text ?? item?.line ?? item?.label ?? item?.message ?? '';
    const normalized = String(text).replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseCsv(value) {
  return (value ?? '')
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function viewportForDevice(device) {
  return {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.deviceScaleFactor,
    mobile: device.mobile,
  };
}

function statusFromChildren(children) {
  const statuses = children.map((child) => child.status);
  if (statuses.every((status) => status === 'captured')) return 'captured';
  if (statuses.every((status) => status === 'failed')) return 'failed';
  return 'partial';
}

function relativeReportPath(path) {
  const rel = relative(reportDir, path);
  return rel.startsWith('..') ? path : rel;
}

function safeSegment(value) {
  return String(value ?? 'unknown')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'unknown';
}

async function writeAggregate() {
  await writeJson(outputPath, {
    version: 1,
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    matrix: matrixPath,
    playthrough_matrix: playthroughMatrixPath,
    filters: {
      flows: requestedFlows,
      screens: requestedScreens,
      groups: requestedGroups,
    },
    deviceProfiles,
    expected_step_count: totalSteps,
    captured_step_count: aggregateFlows
      .flatMap((flow) => flow.devices)
      .flatMap((device) => device.steps)
      .filter((step) => ['captured', 'partial'].includes(step.status)).length,
    flows: aggregateFlows,
  });
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function waitForDebugger() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error('Chrome remote debugging endpoint did not become ready.');
}

async function createPage() {
  const response = await fetch(`http://127.0.0.1:${port}/json/new`, { method: 'PUT' });
  if (!response.ok) throw new Error(`Failed to create page: ${response.status}`);
  return response.json();
}

async function closePage(id) {
  await fetch(`http://127.0.0.1:${port}/json/close/${id}`);
}

function updateLiveReport(status, phase, message, current, total) {
  if (!liveReport) return;
  spawnSync(process.execPath, [
    'tools/qa_update_live_report.mjs',
    '--status',
    status,
    '--phase',
    phase,
    '--message',
    message,
    '--current',
    String(current),
    '--total',
    String(total),
    '--generate',
    '0',
  ], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });
}

async function shutdownAfterSignal(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  updateLiveReport('failed', 'scenario-capture', `시나리오 캡처 중단: ${signal}`, completed, totalSteps);
  chrome.kill('SIGTERM');
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  await writeAggregate().catch(() => {});
  process.exit(130);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
