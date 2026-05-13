#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  assessVisualSubjectCrop,
  evaluateQuantitativeScreenContracts,
} from './qa_quantitative_contracts.mjs';

const screen = {
  id: 'guardian_dialog',
  screen: 'Base Status',
  state: '가디언 대화',
  screenshot: 'final_09_guardian_dialog.png',
};

const speakerContract = {
  version: 1,
  visibleCharacterPolicy: 'exact',
  activeSpeakerIds: ['lamir'],
  expectedVisibleCharacterIds: ['lamir'],
  checks: {
    speakerVisibleOnly: true,
    strictVisibleCharacters: true,
  },
};

{
  const issues = evaluateQuantitativeScreenContracts(screen, {
    screen: 'guardian_dialog',
    screenshot: screen.screenshot,
    sceneContract: speakerContract,
    renderedGuardians: [{ guardianId: 'lamir', visible: true }],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].status, 'PASS');
  assert.match(issues[0].evidence.observed, /expected=\[lamir\], actual=\[lamir\]/);
}

{
  const issues = evaluateQuantitativeScreenContracts(screen, {
    screen: 'guardian_dialog',
    screenshot: screen.screenshot,
    sceneContract: speakerContract,
    renderedGuardians: [
      { guardianId: 'lamir', visible: true },
      { guardianId: 'kael', visible: true },
    ],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].status, 'FAIL');
  assert.equal(issues[0].rule_id, 'speaker_visible_only_contract');
  assert.match(issues[0].evidence.observed, /unexpected=\[kael\]/);
}

{
  const issues = evaluateQuantitativeScreenContracts(screen, {
    screen: 'guardian_dialog',
    screenshot: screen.screenshot,
    sceneContract: speakerContract,
    renderedGuardians: [],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].status, 'BLOCKED');
  assert.match(issues[0].blocked_reason, /이미지 캡처로 speaker portrait를 추정하지 않는다/);
}

const visitorSubject = {
  id: 'visitor:demon_merchant_first_visit',
  kind: 'visitor',
  messageId: 'demon_merchant_first_visit',
  subjectId: 'demon_merchant',
  sourceSize: { width: 1024, height: 1536 },
  subjectBounds: {
    coordinateSpace: 'normalized',
    head: { x: 0.26, y: 0.03, width: 0.48, height: 0.25 },
    core: { x: 0.14, y: 0.03, width: 0.72, height: 0.9 },
  },
  visibility: {
    minRequiredVisibleFraction: 1,
  },
};

{
  const assessment = assessVisualSubjectCrop({
    ...visitorSubject,
    frame: { fit: 'cover', alignment: 'center', containerAspectRatio: 2.7 },
  });
  assert.equal(assessment.status, 'FAIL');
  assert.equal(assessment.headVisibleFraction, 0);
  assert.ok(assessment.coreVisibleFraction < 1);
}

{
  const issues = evaluateQuantitativeScreenContracts(
    { ...screen, id: 'ending_cycle3', state: '3회차 엔딩', screenshot: 'final_25_ending_cycle3.png' },
    {
      screen: 'ending_cycle3',
      screenshot: 'final_25_ending_cycle3.png',
      renderedGuardians: [],
      visualSubjects: [
        {
          ...visitorSubject,
          frame: { fit: 'cover', alignment: 'center', containerAspectRatio: 2.7 },
        },
      ],
    },
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].status, 'FAIL');
  assert.equal(issues[0].rule_id, 'quantitative_crop_contract');
  assert.match(issues[0].evidence.observed, /headVisibleFraction=0/);
}

{
  const issues = evaluateQuantitativeScreenContracts(
    { ...screen, id: 'ending_cycle3', state: '3회차 엔딩', screenshot: 'final_25_ending_cycle3.png' },
    {
      screen: 'ending_cycle3',
      screenshot: 'final_25_ending_cycle3.png',
      renderedGuardians: [],
      visualSubjects: [
        {
          ...visitorSubject,
          frame: { fit: 'contain', alignment: 'topCenter' },
        },
      ],
    },
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].status, 'PASS');
  assert.match(issues[0].evidence.observed, /headVisibleFraction=1/);
  assert.match(issues[0].evidence.observed, /coreVisibleFraction=1/);
}

{
  const issues = evaluateQuantitativeScreenContracts(
    { ...screen, id: 'ending_cycle3', state: '3회차 엔딩', screenshot: 'final_25_ending_cycle3.png' },
    {
      screen: 'ending_cycle3',
      screenshot: 'final_25_ending_cycle3.png',
      renderedGuardians: [],
      visualSubjects: [{ id: 'visitor:unknown', subjectId: 'unknown', frame: { fit: 'cover' } }],
    },
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].status, 'BLOCKED');
  assert.match(issues[0].evidence.observed, /metadata가 부족/);
}

console.log('qa_quantitative_contracts tests passed');
