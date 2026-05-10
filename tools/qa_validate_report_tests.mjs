#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sourceReportDir =
  process.env.QA_REPORT_DIR ?? 'docs/qa/reports/2026-05-09-ui-qa-pipeline';
const tests = [
  ['fail-first artifact validates in not_pass mode', async (dir) => expectPass(dir, { expect: 'not_pass' })],
  ['fail-first report fails strict final pass', async (dir) => expectFail(dir, 'codex product review status must be pass')],
  [
    'synthetic strict pass fixture validates',
    async (dir) => {
      await makeStrictPassFixture(dir);
      expectPass(dir);
    },
  ],
  [
    'missing codex playthrough review fails',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await rm(join(dir, 'codex_playthrough_review.json'));
      expectFail(dir, 'codex_playthrough_review.json is required');
    },
  ],
  [
    'unchecked product review fails',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        review.screens[0].status = 'unchecked';
      });
      expectFail(dir, 'is unchecked');
    },
  ],
  [
    'missing product evidence fails',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        review.screens[0].requiredEvidence = [];
      });
      expectFail(dir, 'missing requiredEvidence');
    },
  ],
  [
    'generic English product review pass text fails',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        review.screens[0].review_note =
          'Loading was reviewed at 390x844; composition, CTA hierarchy, Korean wrapping, and Dragonout HUD treatment are acceptable.';
        review.screens[0].rationale =
          'Fresh screenshot evidence shows no blocking copy/layout regression.';
        review.screens[0].recommended_fix = 'No product-blocking fix required for this screen.';
      });
      expectFail(dir, 'contains generic PASS template text');
    },
  ],
  [
    'meta-only Korean product fail text fails in not_pass mode',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        review.status = 'fail';
        const screen = review.screens[0];
        screen.status = 'fail';
        screen.ship_readiness = 'needs_polish';
        screen.review_note =
          '현재 캡처 기준 명백한 크래시는 없지만, 사용자 기준보다 PASS 문턱이 낮았던 항목으로 재분류했습니다.';
        screen.rationale = '기존 PASS 문턱이 낮았기 때문에 재검수가 필요합니다.';
        screen.recommended_fix = '재검수가 필요합니다.';
        screen.findings = [
          {
            severity: 'P2',
            code: 'product_contract_violation',
            message:
              '제품 계약 위반: 현재 캡처 기준 명백한 크래시는 없지만, 사용자 기준보다 PASS 문턱이 낮았던 항목으로 재분류했습니다.',
          },
        ];
      });
      generateReport(dir, { mode: 'full', expect: 'not_pass' });
      expectFail(dir, 'contains meta failure text', { expect: 'not_pass' });
    },
  ],
  [
    'concrete Korean product fail text validates in not_pass mode',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        review.status = 'fail';
        const screen = review.screens[0];
        screen.status = 'fail';
        screen.ship_readiness = 'needs_polish';
        screen.review_note =
          'final_01_loading.png 원본 390x844 캡처에서 로딩 문구와 진행 피드백의 대비가 약해 첫 진입 긴장감이 기능 상태 표시처럼 읽힌다.';
        screen.rationale =
          'final_01_loading.png은 빈 화면은 아니지만 브랜드 로딩 연출과 진행 상태 계층이 약해 visual/ux 축에서 개발 수정 후보로 남는다.';
        screen.recommended_fix =
          'final_01_loading.png 수정 후보: 로딩 문구를 세계관 문장으로 바꾸고 진행 피드백과 배경 대비를 분리한다.';
        screen.findings = [
          {
            severity: 'P2',
            code: 'current_capture_loading_product_defect',
            rule_id: 'start_cta_ssot_contract',
            target_id: 'start',
            observed_evidence:
              'final_01_loading.png 원본 크기 기준으로 브랜드 로딩 문장과 진행 피드백의 시각 계층이 약하다.',
            pass_criteria:
              '로딩 화면은 브랜드 문장, 진행 피드백, 배경 대비가 서로 다른 계층으로 읽혀야 한다.',
            message:
              'final_01_loading.png 원본 크기 기준: 브랜드 로딩 피드백이 첫 진입 화면의 긴장감보다 기능 상태 표시처럼 읽힌다.',
          },
        ];
      });
      generateReport(dir, { mode: 'full', expect: 'not_pass' });
      expectPass(dir, { expect: 'not_pass' });
    },
  ],
  [
    'product review without Korean evidence fails',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        review.screens[0].review_note = 'final_01_loading.png has branded loading and stable feedback.';
      });
      expectFail(dir, 'must be written in Korean');
    },
  ],
  [
    'product review must mention screenshot file',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        review.screens[0].review_note = '로딩 화면은 브랜드 문장과 진행 피드백이 보이며 빈 화면이 아니다.';
        review.screens[0].rationale = '검은 배경 안에 로딩 상태가 안정적으로 보이고 기본 브라우저 흔적이 없다.';
        review.screens[0].recommended_fix = '개발 큐 제외: 로딩 피드백과 브랜드 표기가 유지되고 있다.';
      });
      expectFail(dir, 'must mention screenshot');
    },
  ],
  [
    'high-risk original-size review is required',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        const baseStatus = review.screens.find((screen) => screen.id === 'base_status');
        baseStatus.reviewed_original = false;
      });
      expectFail(dir, 'high-risk screen must be reviewed_original=true');
    },
  ],
  [
    'P2 product finding blocks pass',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        review.screens[0].findings.push({
          severity: 'P2',
          code: 'forced_p2',
          message: 'forced P2 finding',
        });
      });
      expectFail(dir, 'codex review has P2+ finding');
    },
  ],
  [
    'forbidden contract presence blocks pass',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        review.screens[0].contract_results.forbidden[0].status = 'present';
      });
      expectFail(dir, 'product contract has failing check');
    },
  ],
  [
    'missing expected contract blocks pass',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        review.screens[0].contract_results.expected[0].status = 'fail';
      });
      expectFail(dir, 'product contract has failing check');
    },
  ],
  [
    'not observed contract creates low confidence blocker',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        review.screens[0].contract_results.implementedEvidence[0].status = 'not_observed';
      });
      expectFail(dir, 'product contract has not_observed check');
    },
  ],
  [
    'needs polish is final pass failure',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        review.screens[0].ship_readiness = 'needs_polish';
      });
      expectFail(dir, 'ship_readiness must be commercial_ready');
    },
  ],
  [
    'excessive score 5 blocks pass',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editReview(dir, (review) => {
        for (const screen of review.screens) {
          for (const key of Object.keys(screen.scores)) {
            screen.scores[key] = 5;
          }
        }
      });
      expectFail(dir, 'excessive score=5 usage');
    },
  ],
  [
    'P2 polish lint blocks strict pass',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editLints(dir, (lints) => {
        lints.results[0].status = 'fail';
        lints.results[0].findings.push({
          severity: 'P2',
          code: 'forced_polish_p2',
          message: 'forced polish P2',
        });
        lints.summary.pass -= 1;
        lints.summary.fail += 1;
      });
      generateReport(dir, { mode: 'full' });
      expectFail(dir, 'polish lint not pass');
    },
  ],
  [
    'automated gate failure does not require Codex review in not_pass mode',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editLints(dir, (lints) => {
        lints.results[0].status = 'fail';
        lints.results[0].findings.push({
          severity: 'P2',
          code: 'forced_auto_gate_p2',
          message: 'forced auto gate P2',
        });
        lints.summary.pass -= 1;
        lints.summary.fail += 1;
      });
      await rm(join(dir, 'codex_product_review.json'));
      await rm(join(dir, 'codex_playthrough_review.json'));
      generateReport(dir, { mode: 'full', expect: 'not_pass' });
      expectPass(dir, { expect: 'not_pass' });
    },
  ],
  [
    'profile accepted alone cannot enter development queue without fixed rule',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await setCalibrationStatus(dir, 'CAL-F03', 'accepted', sampleRules('CAL-F03'));
      await makeFlowCandidateFail(dir, 'ending_cycle1_flow', 'CAL-F03');
      generateReport(dir, { mode: 'full', expect: 'not_pass' });
      expectFail(dir, 'profile accepted candidate cannot enter development queue without fixed QA rule', { expect: 'not_pass' });
    },
  ],
  [
    'fixed QA rules can enter development queue independent of profile accepted',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await setCalibrationStatus(dir, 'CAL-S01', 'pending');
      runCurrentReviews(dir);
      generateReport(dir, { mode: 'full', expect: 'not_pass' });
      expectPass(dir, { expect: 'not_pass' });
    },
  ],
  [
    'CAL-S02 fixed QA rules are extracted as regression findings',
    async (dir) => {
      await makeStrictPassFixture(dir);
      runCurrentReviews(dir);
      generateReport(dir, { mode: 'full', expect: 'not_pass' });
      const productReview = JSON.parse(await readFile(join(dir, 'codex_product_review.json'), 'utf8'));
      const baseStatus = productReview.screens.find((screen) => screen.id === 'base_status');
      const findingRuleIds = (baseStatus.findings ?? []).map((finding) => finding.rule_id).sort();
      assertEqualList(findingRuleIds, [
        'cta_ssot_contract',
        'guardian_live2d_layered_motion',
        'guardian_portrait_no_crop',
        'guardian_portrait_scale_consistency',
      ]);
      const html = await readFile(join(dir, 'report.html'), 'utf8');
      for (const ruleId of findingRuleIds) {
        if (!html.includes(ruleId)) throw new Error(`expected report.html to include ${ruleId}`);
      }
      expectPass(dir, { expect: 'not_pass' });
    },
  ],
  [
    'normal report hides calibration setup UI',
    async (dir) => {
      await makeStrictPassFixture(dir);
      const html = await readFile(join(dir, 'report.html'), 'utf8');
      for (const forbidden of ['캘리브레이션 후보표', 'profile JSON 복사', 'calibrationSaveButton', 'type="radio"']) {
        if (html.includes(forbidden)) {
          throw new Error(`expected report.html to hide ${forbidden}`);
        }
      }
      for (const required of ['고정 QA 룰', '수정 큐', 'QA 판정 항목', '전체 QA 판정 항목', 'qa-matrix-grid', 'qa-card', 'contract-summary', 'contract-badge']) {
        if (!html.includes(required)) {
          throw new Error(`expected report.html to include ${required}`);
        }
      }
      for (const forbidden of ['<th>계약 위반</th>', '계약 위반 없음', '실패와 증거 부족 없이', '기대 항목 미충족', '구현 증거 부족']) {
        if (html.includes(forbidden)) {
          throw new Error(`expected report.html not to include generic judgement text ${forbidden}`);
        }
      }
    },
  ],
  [
    'first calibration round contains only regression screens and target flows',
    async (dir) => {
      await makeStrictPassFixture(dir);
      const doc = JSON.parse(await readFile(join(dir, 'qa_calibration_candidates.json'), 'utf8'));
      const screenTargets = doc.candidates.filter((candidate) => candidate.type === 'screen_problem').map((candidate) => candidate.target_id).sort();
      const flowTargets = doc.candidates.filter((candidate) => candidate.type === 'play_experience').map((candidate) => candidate.target_id).sort();
      assertEqualList(screenTargets, ['base_status', 'guardian_dialog', 'location_dialog', 'outing', 'start']);
      const globalTargets = doc.candidates.filter((candidate) => candidate.type === 'global_visual').map((candidate) => candidate.target_id).sort();
      assertEqualList(flowTargets, ['ending_cycle1_flow', 'ending_cycle2_flow', 'ending_cycle3_flow', 'first_report_flow', 'user_regression_flow']);
      assertEqualList(globalTargets, ['global_visual_chrome']);
    },
  ],
  [
    'calibration setup renders separately',
    async (dir) => {
      await makeStrictPassFixture(dir);
      const setupHtml = await readFile(join(dir, 'calibration.html'), 'utf8');
      for (const text of ['Dragonout QA 허들 설정', '허들 설정 후보', '룰 draft', '현재 캡처/흐름 검출 결과', 'CAL-S02', '고정', '재작성', '기각', 'type="radio"']) {
        if (!setupHtml.includes(text)) {
          throw new Error(`expected calibration.html to include ${text}`);
        }
      }
      const reportHtml = await readFile(join(dir, 'report.html'), 'utf8');
      if (reportHtml.includes('calibration.html') || reportHtml.includes('/calibration')) {
        throw new Error('normal report must not link to calibration setup');
      }
    },
  ],
  [
    'missing playthrough transcript fails',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editPlaythroughReview(dir, (review) => {
        review.flows[0].transcript = [];
      });
      expectFail(dir, 'missing transcript');
    },
  ],
  [
    'placeholder playthrough transcript fails',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editPlaythroughReview(dir, (review) => {
        review.flows[0].transcript = [
          'Step 1: start screenshot reviewed in the latest full QA sequence.',
        ];
      });
      expectFail(dir, 'contains generic PASS template text');
    },
  ],
  [
    'meta-only Korean playthrough fail text fails in not_pass mode',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editPlaythroughReview(dir, (review) => {
        review.status = 'fail';
        const flow = review.flows[0];
        flow.verdict = 'fail';
        flow.review_note = '재검수가 필요합니다.';
        flow.recommended_fix = '재검수가 필요합니다.';
        flow.transcript = ['1. screenshot reviewed 후 재검수가 필요합니다.'];
        flow.findings = [
          {
            severity: 'P2',
            code: 'placeholder_playthrough_fail',
            message: '재검수가 필요합니다.',
          },
        ];
      });
      generateReport(dir, { mode: 'full', expect: 'not_pass' });
      expectFail(dir, 'contains meta failure text', { expect: 'not_pass' });
    },
  ],
  [
    'playthrough transcript without Korean evidence fails',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editPlaythroughReview(dir, (review) => {
        review.flows[0].transcript = ['Start screen CTA and base status were checked.'];
      });
      expectFail(dir, 'must be written in Korean');
    },
  ],
  [
    'missing live status target blocks strict pass',
    async (dir) => {
      await makeStrictPassFixture(dir);
      const liveStatus = JSON.parse(await readFile(join(dir, 'qa_live_status.json'), 'utf8'));
      liveStatus.targetWorktree = null;
      await writeJson(join(dir, 'qa_live_status.json'), liveStatus);
      expectFail(dir, 'qa_live_status.json missing targetWorktree');
    },
  ],
  [
    'P2 playthrough finding blocks pass',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editPlaythroughReview(dir, (review) => {
        review.flows[0].findings.push({
          severity: 'P2',
          code: 'forced_playthrough_p2',
          message: 'forced playthrough P2',
        });
      });
      expectFail(dir, 'codex playthrough review has P2+ finding');
    },
  ],
  [
    'fast mode can validate partial not_pass artifacts',
    async (dir) => {
      await makeFastFixture(dir);
      expectPass(dir, { mode: 'fast', expect: 'not_pass' });
    },
  ],
  [
    'fast mode cannot declare final pass',
    async (dir) => {
      await makeFastFixture(dir);
      expectFail(dir, 'QA_MODE=fast cannot declare final PASS', { mode: 'fast', expect: 'pass' });
    },
  ],
  [
    'stale screenshot fails',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await editCapture(dir, (capture) => {
        capture.results[0].bytes += 1;
      });
      expectFail(dir, 'capture result is stale');
    },
  ],
  [
    'missing screenshot fails',
    async (dir) => {
      await makeStrictPassFixture(dir);
      await rm(join(dir, 'screenshots', 'final_01_loading.png'));
      expectFail(dir, 'missing screenshot');
    },
  ],
];

for (const [name, run] of tests) {
  const dir = await mkdtemp(join(tmpdir(), 'dragonout-qa-validator-'));
  try {
    await cp(sourceReportDir, dir, { recursive: true });
    await normalizeCaptureResult(dir);
    await run(dir);
    console.log(`PASS ${name}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function normalizeCaptureResult(dir) {
  const capturePath = join(dir, 'capture_result.json');
  const capture = JSON.parse(await readFile(capturePath, 'utf8'));
  for (const result of capture.results ?? []) {
    const screenshotPath = join(dir, 'screenshots', result.screenshot);
    const fileStat = await stat(screenshotPath);
    result.path = screenshotPath;
    result.bytes = fileStat.size;
    result.mtime = fileStat.mtime.toISOString();
  }
  await writeJson(capturePath, capture);
}

async function makeStrictPassFixture(dir) {
  const matrix = JSON.parse(await readFile('tools/qa_matrix.json', 'utf8'));
  const playthroughMatrix = JSON.parse(await readFile('tools/qa_playthrough_matrix.json', 'utf8'));
  const polishLints = JSON.parse(await readFile(join(dir, 'polish_lints.json'), 'utf8'));
  polishLints.summary = {
    pass: matrix.screens.length,
    low_confidence: 0,
    fail: 0,
  };
  polishLints.results = matrix.screens.map((screen) => ({
    id: screen.id,
    screen: screen.screen,
    state: screen.state,
    screenshot: screen.screenshot,
    status: 'pass',
    metrics: polishLints.results?.find((result) => result.id === screen.id)?.metrics ?? null,
    findings: [],
  }));
  await writeJson(join(dir, 'polish_lints.json'), polishLints);

  const productReview = JSON.parse(await readFile(join(dir, 'codex_product_review.json'), 'utf8'));
  productReview.status = 'pass';
  productReview.pass_statement = '검증용 fixture: 구체적인 한국어 evidence가 있는 경우만 PASS한다.';
  productReview.fixed_rules_source = null;
  productReview.global_visual_findings = [];
  productReview.screens = matrix.screens.map((screen) => ({
    id: screen.id,
    screen: screen.screen,
    state: screen.state,
    screenshot: `screenshots/${screen.screenshot}`,
    status: 'pass',
    ship_readiness: 'commercial_ready',
    reviewed_original:
      screen.mustReviewAtOriginalSize === true ||
      ['start', 'base_status', 'guardian_dialog', 'location_dialog', 'outing'].includes(screen.id),
    scores: Object.fromEntries(matrix.qualityStandard.scoreKeys.map((key) => [key, 4])),
    contract_results: {
      expected: screen.expected.map((item) => ({
        id: item.id,
        label: item.label,
        status: 'pass',
        note: `${screen.screenshot}에서 ${item.label} 기준을 한국어 검수 근거로 확인했다.`,
      })),
      implementedEvidence: screen.implementedEvidence.map((item) => ({
        id: item.id,
        label: item.label,
        status: 'pass',
        note: `${screen.screenshot}에서 ${item.label} 구현 증거가 실제 화면 기준으로 확인됐다.`,
      })),
      forbidden: screen.forbidden.map((item) => ({
        id: item.id,
        label: item.label,
        status: 'absent',
        note: `${screen.screenshot} 원본 크기 검수에서 ${item.label} 금지 패턴은 보이지 않았다.`,
      })),
    },
    requiredEvidence: screen.requiredEvidence,
    review_note: `${screen.screenshot} 원본 크기에서 제목, 본문, CTA, 금지 항목을 확인했고 개발 큐로 넘길 회귀가 없다.`,
    rationale: `${screen.screenshot}의 주요 문구와 표면 상태가 QA 계약을 충족하며 템플릿 PASS가 아닌 관찰 근거를 남긴다.`,
    findings: [],
    recommended_fix: `${screen.screenshot} 개발 큐 제외: 확인된 금지 항목이 없으므로 현재 표면과 문구를 유지한다.`,
  }));
  await writeJson(join(dir, 'codex_product_review.json'), productReview);

  const playthroughReview = {
    generated_at: new Date().toISOString(),
    reviewed_by: 'Codex',
    review_method: '검증용 fixture: 실제 QA에서는 화면 문구를 한국어로 기록해야 한다.',
    status: 'pass',
    fixed_rules_source: null,
    quality_axes: playthroughMatrix.requiredScoreKeys,
    flows: playthroughMatrix.flows.map((flow) => ({
      flow_id: flow.id,
      title: flow.title,
      steps: flow.steps,
      screenshots: flow.steps,
      verdict: 'pass',
      scenario_scores: Object.fromEntries(playthroughMatrix.requiredScoreKeys.map((key) => [key, 4])),
      expectedFlow: flow.acceptanceCriteria.map((label, index) => ({
        id: `expected_flow_${index + 1}`,
        label,
        status: 'pass',
        note: `${flow.title} 흐름에서 기대 기준 ${index + 1}번을 한국어 관찰 근거로 확인했다.`,
      })),
      observedFlow: flow.requiredEvidence.map((label, index) => ({
        id: `observed_flow_${index + 1}`,
        label,
        status: 'pass',
        note: `${flow.title} 흐름에서 ${label} 증거를 실제 화면 순서 기준으로 확인했다.`,
      })),
      forbiddenFlowBreaks: [
        {
          id: 'no_forbidden_flow_break',
          label: 'No forbidden flow break observed.',
          status: 'absent',
          note: `${flow.title} 흐름에서 진행 막힘, 문구 회귀, CTA 오인을 확인하지 못했다.`,
        },
      ],
      transcript: flow.steps.map((step, index) => (
        `${index + 1}. ${step} 화면에서 한국어 문구와 CTA 흐름을 확인했고 다음 행동이 끊기지 않는다.`
      )),
      requiredEvidence: flow.requiredEvidence,
      review_note: `${flow.title}은 화면 순서, 한국어 문구, CTA 연결이 검수 근거로 남아 있다.`,
      findings: [],
      recommended_fix: `${flow.title} 개발 큐 제외: 현재 fixture 기준에서는 흐름 단절이나 회귀가 없다.`,
    })),
  };
  await writeJson(join(dir, 'codex_playthrough_review.json'), playthroughReview);
  await writeJson(join(dir, 'qa_live_status.json'), {
    status: 'complete',
    phase: '검증 완료',
    message: '검증용 fixture: target/report/screenshot 상태가 비어 있지 않다.',
    updated_at: new Date().toISOString(),
    targetWorktree: process.cwd(),
    reportDir: dir,
    screenshotDir: join(dir, 'screenshots'),
    screenshotCount: matrix.screens.length,
    finalStatus: 'PASS',
    generatedAt: new Date().toISOString(),
    events: [],
  });
  generateReport(dir, { mode: 'full' });
}

async function makeFastFixture(dir) {
  await makeStrictPassFixture(dir);
  const capturePath = join(dir, 'capture_result.json');
  const capture = JSON.parse(await readFile(capturePath, 'utf8'));
  capture.mode = 'fast';
  capture.results = capture.results.filter((result) => ['base_status', 'event_choice_enabled'].includes(result.id));
  capture.expected_count = capture.results.length;
  capture.captured_count = capture.results.length;
  await writeJson(capturePath, capture);
  generateReport(dir, { mode: 'fast' });
}

async function editReview(dir, mutate) {
  const path = join(dir, 'codex_product_review.json');
  const review = JSON.parse(await readFile(path, 'utf8'));
  mutate(review);
  await writeJson(path, review);
}

async function editPlaythroughReview(dir, mutate) {
  const path = join(dir, 'codex_playthrough_review.json');
  const review = JSON.parse(await readFile(path, 'utf8'));
  mutate(review);
  await writeJson(path, review);
}

async function editCapture(dir, mutate) {
  const path = join(dir, 'capture_result.json');
  const capture = JSON.parse(await readFile(path, 'utf8'));
  mutate(capture);
  await writeJson(path, capture);
}

async function editLints(dir, mutate) {
  const path = join(dir, 'polish_lints.json');
  const lints = JSON.parse(await readFile(path, 'utf8'));
  mutate(lints);
  await writeJson(path, lints);
}

async function setCalibrationStatus(dir, candidateId, status, learnedRules = []) {
  const candidatesPath = join(dir, 'qa_calibration_candidates.json');
  const profilePath = join(dir, 'qa_calibration_profile.json');
  const candidatesDoc = JSON.parse(await readFile(candidatesPath, 'utf8'));
  for (const candidate of candidatesDoc.candidates ?? []) {
    if (candidate.candidate_id === candidateId) {
      candidate.calibration_status = status;
      candidate.learned_rules = status === 'accepted' ? learnedRules : [];
    }
  }
  await writeJson(candidatesPath, candidatesDoc);
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.accepted = (profile.accepted ?? []).filter((id) => id !== candidateId);
  profile.rejected = (profile.rejected ?? []).filter((id) => id !== candidateId);
  profile.deferred = profile.deferred && !Array.isArray(profile.deferred) ? profile.deferred : {};
  profile.learned_rules = profile.learned_rules && !Array.isArray(profile.learned_rules) ? profile.learned_rules : {};
  if (Array.isArray(profile.needs_rewrite)) {
    profile.needs_rewrite = profile.needs_rewrite.filter((id) => id !== candidateId);
  } else {
    delete profile.needs_rewrite?.[candidateId];
  }
  delete profile.deferred[candidateId];
  delete profile.learned_rules[candidateId];
  if (status === 'accepted') {
    profile.accepted.push(candidateId);
    profile.learned_rules[candidateId] = learnedRules;
  } else if (status === 'rejected') {
    profile.rejected.push(candidateId);
  } else if (status === 'needs_rewrite') {
    profile.needs_rewrite = {
      ...(profile.needs_rewrite && !Array.isArray(profile.needs_rewrite) ? profile.needs_rewrite : {}),
      [candidateId]: '테스트 fixture에서 재작성 필요 상태로 지정했다.',
    };
  } else if (status === 'deferred') {
    profile.deferred[candidateId] = '테스트 fixture에서 나중에 상태로 지정했다.';
  }
  await writeJson(profilePath, profile);
}

async function makeStartCandidateFail(dir) {
  await editReview(dir, (review) => {
    review.status = 'fail';
    const screen = review.screens.find((item) => item.id === 'start');
    screen.status = 'fail';
    screen.ship_readiness = 'needs_polish';
    screen.review_note =
      'final_02_start.png 후보 CAL-S01이 개발 큐로 승격된 상태이며 첫 행동 CTA 주변 문구 역할을 분리해야 한다.';
    screen.rationale =
      'final_02_start.png 캘리브레이션 후보가 사용자 기준에 의해 확정되면 시작 화면 수정 대상이 된다.';
    screen.recommended_fix =
      'final_02_start.png 개발 큐: 타이틀 아래 문장과 CTA 주변 문구의 역할을 나누고 첫 행동 payoff를 강화한다.';
    screen.findings = [
      {
        severity: 'P2',
        code: 'start_cta_ssot_contract_learned_qa_rule',
        candidate_id: 'CAL-S01',
        rule_id: 'start_cta_ssot_contract',
        message:
          'final_02_start.png 학습된 QA 규칙 위반: 시작 화면 CTA는 SSoT 계약을 지켜야 한다.',
      },
    ];
  });
}

async function makeFlowCandidateFail(dir, flowId, candidateId) {
  await editPlaythroughReview(dir, (review) => {
    review.status = 'fail';
    const flow = review.flows.find((item) => item.flow_id === flowId);
    flow.verdict = 'fail';
    flow.review_note =
      `${flow.title} 후보 ${candidateId}가 profile accepted만으로 개발 큐에 들어간 잘못된 fixture다.`;
    flow.recommended_fix =
      `${flow.title} 개발 큐는 repo-tracked 고정 QA 룰 finding이 있을 때만 생성되어야 한다.`;
    flow.findings = [
      {
        severity: 'P2',
        code: `${candidateId.toLowerCase()}_profile_only_flow_fail`,
        candidate_id: candidateId,
        rule_id: 'ending_cycle1_payoff_rule_missing_from_fixed_rules',
        target_id: flowId,
        observed_evidence:
          `${flow.title}은 profile accepted 상태만 있고 repo-tracked 고정 QA 룰이 없는 상태에서 FAIL로 승격됐다.`,
        pass_criteria:
          `${flow.title} 개발 큐는 고정 QA 룰 파일의 rule_id와 matching finding이 있을 때만 표시되어야 한다.`,
        message:
          `${flow.title} profile accepted-only fixture: 고정 QA 룰 없이 개발 큐에 들어간 항목이다.`,
      },
    ];
  });
}

function runCurrentReviews(reportDir) {
  const result = spawnSync(process.execPath, ['tools/qa_write_current_reviews.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      QA_REPORT_DIR: reportDir,
      QA_PRODUCT_REVIEW_PATH: join(reportDir, 'codex_product_review.json'),
      QA_PLAYTHROUGH_REVIEW_PATH: join(reportDir, 'codex_playthrough_review.json'),
      QA_CALIBRATION_PROFILE_PATH: join(reportDir, 'qa_calibration_profile.json'),
      QA_CALIBRATION_CANDIDATES_PATH: join(reportDir, 'qa_calibration_candidates.json'),
      QA_POLISH_LINTS_PATH: join(reportDir, 'polish_lints.json'),
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`failed to run current reviews:\n${result.stderr}`);
  }
}

function sampleRules(candidateId) {
  return [
    {
      rule_id: 'start_cta_ssot_contract',
      candidate_id: candidateId,
      assertion: '시작 화면 CTA는 SSoT 계약의 시작 행동 명칭과 일치해야 한다.',
      current_observation: '테스트 fixture에서 시작 화면 CTA 계약 위반을 학습 규칙 위반으로 지정했다.',
      pass_criteria: 'CTA 문구와 상태 전이가 SSoT의 시작 행동 명칭과 일치해야 한다.',
      severity: 'P2',
      source: 'test_fixture',
    },
  ];
}

function calS02Rules() {
  return [
    {
      rule_id: 'guardian_portrait_scale_consistency',
      assertion: '거점 가디언 초상화는 카드 사이 얼굴/상반신 비율이 일관되지 않으면 FAIL이다.',
      current_observation: '테스트 fixture에서 CAL-S02가 가디언 초상화 비율 불일치를 잡아내야 한다.',
      pass_criteria: '모든 가디언 카드에서 얼굴 크기와 상반신 노출 기준선이 같은 portrait spec 안에 들어와야 한다.',
      severity: 'P0',
      source: 'test_fixture',
    },
    {
      rule_id: 'guardian_portrait_no_crop',
      assertion: '가디언 portrait는 머리와 핵심 실루엣이 카드 안전영역에서 잘리면 FAIL이다.',
      current_observation: '테스트 fixture에서 CAL-S02가 카엘 머리 크롭을 잡아내야 한다.',
      pass_criteria: '카엘을 포함한 모든 portrait의 머리와 핵심 실루엣이 카드 내부 안전영역에 온전히 들어와야 한다.',
      severity: 'P0',
      source: 'test_fixture',
    },
    {
      rule_id: 'guardian_live2d_layered_motion',
      assertion: '가디언 표현은 레이어 단위 Live2D-like 상태 변화가 없고 정지 이미지처럼 보이면 FAIL이다.',
      current_observation: '테스트 fixture에서 CAL-S02가 Live2D 레이어 부재와 정지 이미지 수준 표현을 잡아내야 한다.',
      pass_criteria: '눈/호흡/표정/오버레이 등 레이어 단위 움직임 또는 상태 변화가 portrait 단위로 확인되어야 한다.',
      severity: 'P0',
      source: 'test_fixture',
    },
    {
      rule_id: 'cta_ssot_contract',
      assertion: '거점 화면 CTA는 SSoT 계약의 행동 명칭과 상태 전이를 어기면 FAIL이다.',
      current_observation: '테스트 fixture에서 CAL-S02가 CTA SSoT 계약 위반을 잡아내야 한다.',
      pass_criteria: 'CTA 문구, 상태, 전이가 SSoT에 정의된 행동명과 동일하며 화면 내 다른 문구와 충돌하지 않아야 한다.',
      severity: 'P0',
      source: 'test_fixture',
    },
  ];
}

function assertEqualList(actual, expected) {
  const actualText = actual.join(',');
  const expectedText = expected.join(',');
  if (actualText !== expectedText) {
    throw new Error(`expected [${expectedText}], got [${actualText}]`);
  }
}

function expectPass(dir, options = {}) {
  const result = runValidator(dir, options);
  if (result.status !== 0) {
    throw new Error(`expected pass, got failure:\n${result.stderr}`);
  }
}

function expectFail(dir, expectedText, options = {}) {
  const result = runValidator(dir, options);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) {
    throw new Error(`expected failure containing ${expectedText}, got pass`);
  }
  if (!output.includes(expectedText)) {
    throw new Error(`expected failure containing ${expectedText}, got:\n${output}`);
  }
}

function runValidator(reportDir, options = {}) {
  return spawnSync(process.execPath, ['tools/qa_validate_report.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      QA_REPORT_DIR: reportDir,
      QA_MODE: options.mode ?? 'full',
      QA_EXPECT_FINAL_STATUS: options.expect ?? 'pass',
    },
    encoding: 'utf8',
  });
}

function generateReport(reportDir, options = {}) {
  const result = spawnSync(process.execPath, ['tools/qa_generate_html_report.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      QA_REPORT_DIR: reportDir,
      QA_MODE: options.mode ?? 'full',
      QA_EXPECT_FINAL_STATUS: options.expect ?? 'pass',
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`failed to generate fixture report:\n${result.stderr}`);
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
