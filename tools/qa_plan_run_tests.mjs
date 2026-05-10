#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const tests = [
  [
    'common UI selects high-risk fast groups',
    ['lib/ui/hud.dart'],
    (plan) => {
      assert(plan.mode === 'fast', 'expected fast mode');
      assert(plan.screens.includes('base_status'), 'expected base_status');
      assert(plan.screens.includes('event_choice_enabled'), 'expected event_choice_enabled');
      assert(plan.final_pass_allowed === false, 'fast plan must not allow final pass');
    },
  ],
  [
    'content changes select narrative flows',
    ['lib/content/events.dart'],
    (plan) => {
      assert(plan.playthroughs.includes('first_report_flow'), 'expected first_report_flow');
      assert(plan.playthroughs.includes('archive_flow'), 'expected archive_flow');
      assert(plan.playthroughs.includes('ending_cycle1_flow'), 'expected ending flow');
    },
  ],
  [
    'ending service selects ending and regression',
    ['lib/services/ending_service.dart'],
    (plan) => {
      assert(plan.screens.includes('ending_cycle3'), 'expected ending_cycle3');
      assert(plan.playthroughs.includes('user_regression_flow'), 'expected user regression flow');
    },
  ],
  [
    'unknown change escalates full QA',
    ['scripts/unknown.sh'],
    (plan) => {
      assert(plan.mode === 'full', 'expected full mode');
      assert(plan.final_pass_allowed === true, 'full plan allows final pass after strict validation');
      assert(plan.screens.length === 25, 'full plan must include 25 screens');
    },
  ],
];

for (const [name, files, verify] of tests) {
  const result = spawnSync(process.execPath, ['tools/qa_plan_run.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, QA_CHANGED_FILES: files.join(',') },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`qa_plan_run failed for ${name}:\n${result.stderr}`);
  }
  verify(JSON.parse(result.stdout));
  console.log(`PASS ${name}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
