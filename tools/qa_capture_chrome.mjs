#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

class CdpClient {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CdpClient(ws)));
      ws.addEventListener('error', reject);
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) {
        return;
      }
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
    });
  }

  send(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload);
    });
  }

  close() {
    this.ws.close();
  }
}

const chromePath =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = process.env.QA_BASE_URL ?? 'http://127.0.0.1:64618';
const outputDir = process.env.QA_SCREENSHOT_DIR;
const matrixPath = process.env.QA_MATRIX_PATH ?? 'tools/qa_matrix.json';
const onlyScreen = process.env.QA_SCREEN_FILTER;
const onlyGroups = parseCsv(process.env.QA_GROUP);
const changedFiles = parseCsv(process.env.QA_CHANGED_FILES);
const qaMode = process.env.QA_MODE ?? (onlyScreen || onlyGroups.length > 0 || changedFiles.length > 0 ? 'fast' : 'full');
const liveReport = process.env.QA_LIVE_REPORT === '1';
const port = Number(process.env.QA_DEBUG_PORT ?? 9444);
const headless = process.env.QA_HEADLESS !== '0';

if (!outputDir) {
  throw new Error('QA_SCREENSHOT_DIR is required.');
}

const matrixText = await readFile(matrixPath, 'utf8');
const matrix = JSON.parse(matrixText);
const width = Number(process.env.QA_WIDTH ?? matrix.viewport?.width ?? 390);
const height = Number(process.env.QA_HEIGHT ?? matrix.viewport?.height ?? 844);
const startedAt = new Date().toISOString();
const groupsFromChangedFiles = deriveGroupsFromChangedFiles(changedFiles);
const activeGroups = new Set([...onlyGroups, ...groupsFromChangedFiles]);
const targets = matrix.screens
  .filter(({ qaScreen, id, fastQaGroup }) => {
    if (onlyScreen && qaScreen !== onlyScreen && id !== onlyScreen) {
      return false;
    }
    if (activeGroups.size > 0 && !activeGroups.has(fastQaGroup)) {
      return false;
    }
    return true;
  })
  .map((screen) => ({
    ...screen,
    fileName: screen.screenshot,
    waitMs: screen.waitMs ?? 4500,
    wheelY: screen.wheelY ?? 0,
  }));

await mkdir(outputDir, { recursive: true });
const reportDir = dirname(outputDir);
const cachePath = join(reportDir, 'capture_cache.json');
const sourceHash = hashText(`${process.env.QA_SOURCE_HASH ?? ''}\n${matrixText}\n${changedFiles.join('\n')}`);
const captureCache = qaMode === 'full' ? { entries: {} } : await readCache(cachePath);
const userDataDir = await mkdtemp(join(tmpdir(), 'dragonout-cdp-profile-'));
const results = [];
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
  `--window-size=${width},${height}`,
  'about:blank',
];
if (headless) {
  chromeArgs.unshift('--headless=new');
}

const chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore' });

try {
  await waitForDebugger();
  updateLiveReport('running', 'capture', `캡처 시작: ${targets.length}개 화면`, 0, targets.length);
  for (const target of targets) {
    const { id, qaScreen, fileName, waitMs, wheelY } = target;
    const url = `${baseUrl}/?qaScreen=${encodeURIComponent(qaScreen)}`;
    const outputPath = join(outputDir, fileName);
    const cacheKey = `${id}:${width}x${height}:${sourceHash}`;
    const cached = captureCache.entries?.[id];
    if (qaMode !== 'full' && cached?.cacheKey === cacheKey && (await fileExists(outputPath))) {
      const fileStat = await stat(outputPath);
      results.push({
        id,
        qaScreen,
        screenshot: fileName,
        path: outputPath,
        status: 'skipped_cached',
        width,
        height,
        bytes: fileStat.size,
        mtime: fileStat.mtime.toISOString(),
        cacheKey,
      });
      console.log(`${qaScreen} -> ${fileName} (cached)`);
      updateLiveReport('running', 'capture', `캐시 사용: ${qaScreen}`, results.length, targets.length);
      continue;
    }
    const page = await createPage();
    const client = await CdpClient.connect(page.webSocketDebuggerUrl);
    try {
      await client.send('Page.enable');
      await client.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await client.send('Page.navigate', { url });
      await sleep(waitMs);
      if (wheelY > 0) {
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round(width / 2),
          y: Math.round(height / 2),
          deltaX: 0,
          deltaY: wheelY,
        });
        await sleep(900);
      }
      const screenshot = await client.send(
        'Page.captureScreenshot',
        { format: 'png', fromSurface: true },
        20000,
      );
      await writeFile(outputPath, screenshot.data, 'base64');
      const fileStat = await stat(outputPath);
      const domMeta = await captureDomMeta(client).catch(() => null);
      results.push({
        id,
        qaScreen,
        screenshot: fileName,
        path: outputPath,
        status: 'captured',
        width,
        height,
        bytes: fileStat.size,
        mtime: fileStat.mtime.toISOString(),
        cacheKey,
        ...(domMeta ? { domMeta } : {}),
      });
      captureCache.entries ??= {};
      captureCache.entries[id] = {
        cacheKey,
        screenshot: fileName,
        bytes: fileStat.size,
        mtime: fileStat.mtime.toISOString(),
      };
      console.log(`${qaScreen} -> ${fileName}`);
      updateLiveReport('running', 'capture', `캡처 완료: ${qaScreen}`, results.length, targets.length);
    } catch (error) {
      results.push({
        id,
        qaScreen,
        screenshot: fileName,
        path: outputPath,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      updateLiveReport('failed', 'capture', `캡처 실패: ${qaScreen}`, results.length, targets.length);
      throw error;
    } finally {
      client.close();
      await closePage(page.id).catch(() => {});
    }
  }
} finally {
  chrome.kill('SIGTERM');
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  if (qaMode !== 'full') {
    await writeFile(cachePath, `${JSON.stringify(captureCache, null, 2)}\n`).catch(() => {});
  }
  await writeCaptureResult().catch(() => {});
  await writeScreenArtifacts().catch(() => {});
  updateLiveReport('running', 'capture', `캡처 결과 저장: ${results.length}/${targets.length}`, results.length, targets.length);
}

async function writeCaptureResult() {
  await writeFile(
    join(reportDir, 'capture_result.json'),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        started_at: startedAt,
        matrix: matrixPath,
        mode: qaMode,
        filters: {
          screen: onlyScreen ?? null,
          groups: [...activeGroups],
          changed_files: changedFiles,
          cache_enabled: qaMode !== 'full',
        },
        viewport: { width, height },
        expected_count: targets.length,
        captured_count: results.filter((result) => result.status === 'captured' || result.status === 'skipped_cached').length,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

async function waitForDebugger() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error('Chrome remote debugging endpoint did not become ready.');
}

async function createPage() {
  const response = await fetch(`http://127.0.0.1:${port}/json/new`, {
    method: 'PUT',
  });
  if (!response.ok) {
    throw new Error(`Failed to create page: ${response.status}`);
  }
  return response.json();
}

async function closePage(id) {
  await fetch(`http://127.0.0.1:${port}/json/close/${id}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  ], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });
}

function parseCsv(value) {
  return (value ?? '')
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function deriveGroupsFromChangedFiles(files) {
  const groups = new Set();
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/');
    if (normalized.includes('theme') || normalized.includes('hud') || normalized.includes('screen_frame') || normalized.includes('common')) {
      ['base', 'base_dialog', 'event', 'report', 'ending'].forEach((group) => groups.add(group));
    } else if (normalized.includes('l10n') || normalized.includes('copy') || normalized.includes('content') || normalized.includes('event_card') || normalized.endsWith('CONTENT.md')) {
      ['report', 'event', 'archive', 'ending', 'regression'].forEach((group) => groups.add(group));
    } else if (normalized.includes('ending') || normalized.includes('guardian') || normalized.includes('event_service')) {
      ['base_dialog', 'event', 'ending', 'regression'].forEach((group) => groups.add(group));
    } else if (normalized.startsWith('lib/') || normalized.startsWith('assets/')) {
      ['base', 'report', 'event', 'regression'].forEach((group) => groups.add(group));
    }
  }
  return groups;
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readCache(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { entries: {} };
  }
}

async function captureDomMeta(client) {
  const lockUnlockKeywords = ['lock', 'unlock', '잠김', '해금', '잠금', '해제'];
  const result = await client.send('Runtime.evaluate', {
    expression: `
      (() => {
        const visibleText = (document.body?.innerText ?? '')
          .split('\\n').map(s => s.trim()).filter(Boolean).slice(0, 200);

        const ctaEls = [...document.querySelectorAll('button,[role="button"],[role="link"]')];
        const primaryCtas = ctaEls.slice(0, 30).map(el => {
          const rect = el.getBoundingClientRect();
          const label = (el.textContent?.trim() ?? el.getAttribute('aria-label') ?? '').slice(0, 80);
          const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
          const disabledReason = disabled
            ? (el.getAttribute('data-disabled-reason') ?? el.getAttribute('aria-describedby') ?? null)
            : null;
          const action = el.getAttribute('data-action') ?? el.getAttribute('href') ?? el.getAttribute('data-route') ?? null;
          const semanticRole = el.getAttribute('role') ?? (el.tagName === 'BUTTON' ? 'button' : 'link');
          return {
            label,
            enabled: !disabled,
            action,
            bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            semanticRole,
            disabledReason,
          };
        }).filter(cta => cta.label || cta.action);

        const qaSnapshot = window.__QA_SNAPSHOT__ ?? null;

        const guardianEls = [...document.querySelectorAll('[data-guardian-id],[data-character-id]')];
        const ariaGuardians = guardianEls.slice(0, 10).map(el => {
          const rect = el.getBoundingClientRect();
          return {
            guardianId: el.getAttribute('data-guardian-id') ?? el.getAttribute('data-character-id'),
            displayName: (el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '').slice(0, 40),
            semanticId: el.getAttribute('data-portrait-asset') ?? el.getAttribute('data-guardian-id') ?? null,
            state: el.getAttribute('data-state') ?? 'unknown',
            bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            visible: rect.width > 0 && rect.height > 0,
            evidence: 'aria_dom',
          };
        });

        const locationEls = [...document.querySelectorAll('[data-location-id]')];
        const ariaLocations = locationEls.slice(0, 10).map(el => {
          const rect = el.getBoundingClientRect();
          return {
            locationId: el.getAttribute('data-location-id'),
            displayName: (el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '').slice(0, 40),
            stability: el.getAttribute('data-stability') ?? 'unknown',
            narrativeState: el.getAttribute('data-narrative-state') ?? '',
            bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            visible: rect.width > 0 && rect.height > 0,
            evidence: 'aria_dom',
          };
        });

        const imgSrcs = [...document.querySelectorAll('img')]
          .map(el => el.src || el.getAttribute('src') || '')
          .filter(Boolean).slice(0, 30);

        const ariaLabels = [...document.querySelectorAll('[aria-label]')]
          .map(el => (el.getAttribute('aria-label') ?? '').trim().slice(0, 80))
          .filter(Boolean).slice(0, 30);

        const allText = document.body?.innerText ?? '';
        const keywords = ${JSON.stringify(lockUnlockKeywords)};
        const lockUnlockHints = keywords.filter(k => allText.toLowerCase().includes(k.toLowerCase()));

        return { visibleText, primaryCtas, qaSnapshot, ariaGuardians, ariaLocations, imgSrcs, ariaLabels, lockUnlockHints };
      })()
    `,
    returnByValue: true,
    timeout: 5000,
  });
  return result?.result?.value ?? null;
}

function buildScreenArtifact(target, captureResult, domMeta, viewport) {
  const { id, qaScreen, fileName: screenshot } = target;
  const route = `/?qaScreen=${encodeURIComponent(qaScreen)}`;
  const captureStatus = captureResult?.status;
  const status = (captureStatus === 'captured' || captureStatus === 'skipped_cached') ? 'captured'
    : captureStatus === 'failed' ? 'failed'
    : 'failed';

  if (!domMeta) {
    return {
      screen: id,
      screenshot,
      status,
      metadataQuality: status === 'failed' ? 'failed' : 'stub',
      route,
      viewport,
      visibleText: [],
      primaryCtas: [],
      renderedGuardians: [],
      renderedLocations: [],
      gameState: null,
      missingEvidence: ['domMeta capture failed — visibleText, CTAs, guardians, locations all missing'],
      source: ['capture_failed'],
    };
  }

  const snap = domMeta.qaSnapshot ?? null;
  const visibleText = Array.isArray(domMeta.visibleText) ? domMeta.visibleText : [];
  const primaryCtas = Array.isArray(domMeta.primaryCtas) ? domMeta.primaryCtas : [];

  let renderedGuardians = [];
  let guardianSource = null;
  if (snap?.guardians?.length > 0) {
    renderedGuardians = snap.guardians.map(g => ({
      guardianId: g.guardianId,
      displayName: g.displayName,
      portraitAssetId: g.portraitAssetId ?? null,
      semanticId: g.portraitAssetId ?? g.guardianId,
      state: g.state ?? 'unknown',
      bounds: g.bounds ?? null,
      visible: g.visible ?? true,
      evidence: 'qa_snapshot',
    }));
    guardianSource = 'qa_snapshot';
  } else if (domMeta.ariaGuardians?.length > 0) {
    renderedGuardians = domMeta.ariaGuardians;
    guardianSource = 'aria_dom';
  }

  let renderedLocations = [];
  let locationSource = null;
  if (snap?.locations?.length > 0) {
    renderedLocations = snap.locations.map(l => ({
      locationId: l.locationId,
      displayName: l.displayName,
      stability: l.stability ?? 'unknown',
      narrativeState: l.narrativeState ?? '',
      bounds: l.bounds ?? null,
      visible: l.visible ?? true,
      evidence: 'qa_snapshot',
    }));
    locationSource = 'qa_snapshot';
  } else if (domMeta.ariaLocations?.length > 0) {
    renderedLocations = domMeta.ariaLocations;
    locationSource = 'aria_dom';
  }

  const gameState = snap?.gameState ?? null;

  const hasText = visibleText.length > 0;
  const hasCtaOrGuardianOrLocation = primaryCtas.length > 0 || renderedGuardians.length > 0 || renderedLocations.length > 0;
  const hasGameState = gameState !== null;

  let metadataQuality;
  if (hasText && hasCtaOrGuardianOrLocation && hasGameState) {
    metadataQuality = 'captured';
  } else if (hasText || hasCtaOrGuardianOrLocation) {
    metadataQuality = 'partial';
  } else {
    metadataQuality = 'stub';
  }

  const missingEvidence = [];
  if (!hasText) missingEvidence.push('visibleText is empty — page may be canvas-rendered or innerText unavailable');
  if (primaryCtas.length === 0) missingEvidence.push('primaryCtas is empty — no button/role=button elements found');
  if (!snap && renderedGuardians.length === 0) missingEvidence.push('renderedGuardians missing — window.__QA_SNAPSHOT__ absent and no data-guardian-id attributes found');
  if (!snap && renderedLocations.length === 0) missingEvidence.push('renderedLocations missing — window.__QA_SNAPSHOT__ absent and no data-location-id attributes found');
  if (!hasGameState) missingEvidence.push('gameState null — window.__QA_SNAPSHOT__.gameState not exposed by app');

  const sourceList = ['captureDomMeta'];
  if (snap) sourceList.push('window.__QA_SNAPSHOT__');
  if (guardianSource) sourceList.push(`guardians:${guardianSource}`);
  if (locationSource) sourceList.push(`locations:${locationSource}`);

  return {
    screen: id,
    screenshot,
    status,
    metadataQuality,
    route,
    viewport,
    visibleText,
    primaryCtas,
    renderedGuardians,
    renderedLocations,
    gameState,
    missingEvidence,
    source: sourceList,
  };
}

async function writeScreenArtifacts() {
  const artifactsDir = join(reportDir, 'screen_artifacts');
  await mkdir(artifactsDir, { recursive: true });

  const resultById = new Map(results.map(r => [r.id, r]));
  const artifacts = targets.map(target => {
    const captureResult = resultById.get(target.id) ?? null;
    const domMeta = captureResult?.domMeta ?? null;
    return buildScreenArtifact(target, captureResult, domMeta, { width, height });
  });

  for (const artifact of artifacts) {
    await writeFile(
      join(artifactsDir, `${artifact.screen}.json`),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
  }

  await writeFile(
    join(reportDir, 'screen_artifacts.json'),
    `${JSON.stringify(
      {
        version: 1,
        generated_at: new Date().toISOString(),
        viewport: { width, height },
        artifacts,
      },
      null,
      2,
    )}\n`,
  );
}
