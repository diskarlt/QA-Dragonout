#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const reportDir =
  process.env.QA_REPORT_DIR ?? 'docs/qa/reports/2026-05-09-ui-qa-pipeline';
const liveStatusPath = process.env.QA_LIVE_STATUS_PATH ?? join(reportDir, 'qa_live_status.json');
const args = parseArgs(process.argv.slice(2));
const previous = await readJsonIfExists(liveStatusPath);
const event = {
  at: new Date().toISOString(),
  phase: args.phase ?? previous.phase ?? '대기',
  status: args.status ?? previous.status ?? 'running',
  message: args.message ?? previous.message ?? '',
};
const next = {
  ...previous,
  status: event.status,
  phase: event.phase,
  message: event.message,
  current: numberOrPrevious(args.current, previous.current),
  total: numberOrPrevious(args.total, previous.total),
  refresh_ms: Number(args.refreshMs ?? previous.refresh_ms ?? 7000),
  updated_at: event.at,
  events: [...(previous.events ?? []), event].slice(-80),
};

await writeFile(liveStatusPath, `${JSON.stringify(next, null, 2)}\n`);

const skipReport = args.generate === '0' || args.generate === 'false';
if (!skipReport) {
  const result = spawnSync(process.execPath, ['tools/qa_generate_html_report.mjs'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(result.stdout);
}

console.log(`Live QA status updated: ${next.status} / ${next.phase}`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = '1';
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function numberOrPrevious(value, previous) {
  if (value === undefined) return previous ?? 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : previous ?? 0;
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { events: [] };
  }
}
