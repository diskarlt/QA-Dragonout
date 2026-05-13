import {
  blockedIssue,
  normalizeQaIssue,
  passIssue,
} from './qa_queue_model.mjs';

const FULL_RECT = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

export function evaluateQuantitativeScreenContracts(screen, artifact) {
  if (!artifact) return [];
  return [
    ...evaluateSpeakerContract(screen, artifact),
    ...evaluateVisualSubjectContracts(screen, artifact),
  ];
}

export function evaluateSpeakerContract(screen, artifact) {
  const contract = artifact.sceneContract ?? null;
  if (!contract) return [];

  const checks = contract.checks ?? {};
  const strict =
    checks.speakerVisibleOnly === true ||
    checks.strictVisibleCharacters === true ||
    contract.visibleCharacterPolicy === 'exact';
  if (!strict) return [];

  const expected = uniqueStrings(
    contract.activeSpeakerIds?.length > 0
      ? contract.activeSpeakerIds
      : contract.expectedVisibleCharacterIds,
  );
  const actual = visibleGuardianIds(artifact);
  const sourcePointer = `codex_product_review.json:screens:${screen.id}:speaker_visible_only_contract`;
  const evidencePointer = `screen_artifacts/${screen.id}.json:sceneContract`;

  if (expected.length === 0) {
    return [
      blockedIssue({
        id: `${screen.id}.speaker_visible_only_contract`,
        source: 'product_review',
        targetType: 'screen',
        targetId: screen.id,
        screenshot: screen.screenshot,
        severity: 'P2',
        category: 'code_level_screen_contract',
        ruleId: 'speaker_visible_only_contract',
        observed: `${screen.screenshot} sceneContract가 strict speaker 검증을 요구하지만 activeSpeakerIds 또는 expectedVisibleCharacterIds가 비어 있다.`,
        expected: `${screen.state} 화면은 현재 대사의 speaker id를 expected visible character로 제공해야 한다.`,
        missingEvidence: ['sceneContract.activeSpeakerIds', 'sceneContract.expectedVisibleCharacterIds'],
        requiredArtifact: ['screen_artifacts.json', `screen_artifacts/${screen.id}.json`],
        blockedReason: 'speaker id contract가 없어 이미지 캡처를 보고 캐릭터를 추정하지 않는다.',
        passCondition: 'active speaker id와 rendered guardian id set이 정확히 일치해야 한다.',
        recommendedFix: '앱 QA snapshot에 active speaker id와 expected visible character id를 기록한다.',
        sourcePointer,
        evidencePointer,
      }),
    ];
  }

  if (actual.length === 0) {
    return [
      blockedIssue({
        id: `${screen.id}.speaker_visible_only_contract`,
        source: 'product_review',
        targetType: 'screen',
        targetId: screen.id,
        screenshot: screen.screenshot,
        severity: 'P2',
        category: 'code_level_screen_contract',
        ruleId: 'speaker_visible_only_contract',
        observed: `${screen.screenshot} expected speaker=${expected.join(', ')} contract는 있으나 renderedGuardians metadata가 비어 있다.`,
        expected: `${screen.state} 화면은 rendered guardian id set을 제공해야 한다.`,
        missingEvidence: ['renderedGuardians.guardianId'],
        requiredArtifact: ['screen_artifacts.json', `screen_artifacts/${screen.id}.json`],
        blockedReason: 'rendered guardian id가 없어 이미지 캡처로 speaker portrait를 추정하지 않는다.',
        passCondition: 'active speaker id와 rendered guardian id set이 정확히 일치해야 한다.',
        recommendedFix: 'QA snapshot 또는 DOM metadata에 실제 표시 guardian id를 기록한다.',
        sourcePointer,
        evidencePointer,
      }),
    ];
  }

  const mismatch = setMismatch(expected, actual);
  const observed =
    `${screen.screenshot} sceneContract speaker 검증: ` +
    `expected=[${expected.join(', ')}], actual=[${actual.join(', ')}], ` +
    `missing=[${mismatch.missing.join(', ') || '없음'}], unexpected=[${mismatch.unexpected.join(', ') || '없음'}].`;

  if (mismatch.missing.length > 0 || mismatch.unexpected.length > 0) {
    return [
      normalizeQaIssue({
        id: `${screen.id}.speaker_visible_only_contract`,
        source: 'product_review',
        target_type: 'screen',
        target_id: screen.id,
        status: 'FAIL',
        severity: 'P1',
        category: 'code_level_screen_contract',
        rule_id: 'speaker_visible_only_contract',
        evidence: {
          screenshot: screen.screenshot,
          observed,
        },
        expected: `${screen.state} 화면은 active speaker id와 rendered guardian id set이 정확히 일치해야 한다.`,
        recommended_fix:
          '대화 scene의 active speaker contract 또는 실제 렌더링 portrait 노출 대상을 일치시킨다.',
        pass_condition:
          'screen_artifact sceneContract.activeSpeakerIds와 renderedGuardians id set이 같은 순서 무관 set이어야 한다.',
        regression_lock: true,
        source_pointer: sourcePointer,
        evidence_pointer: evidencePointer,
      }),
    ];
  }

  return [
    passIssue({
      id: `${screen.id}.speaker_visible_only_contract`,
      source: 'product_review',
      targetType: 'screen',
      targetId: screen.id,
      screenshot: screen.screenshot,
      severity: 'P3',
      category: 'code_level_screen_contract',
      ruleId: 'speaker_visible_only_contract',
      observed,
      expected: `${screen.state} 화면은 active speaker만 표시해야 한다.`,
      passCondition:
        'active speaker id와 rendered guardian id set이 정확히 일치해야 한다.',
      passEvidence: observed,
      sourcePointer,
      evidencePointer,
    }),
  ];
}

export function evaluateVisualSubjectContracts(screen, artifact) {
  const subjects = visualSubjectsForArtifact(artifact);
  return subjects.flatMap((subject) => visualSubjectIssue(screen, artifact, subject));
}

export function assessVisualSubjectCrop(subject) {
  const visibility = subject.visibility ?? {};
  const minRequired = finiteNumber(
    visibility.minRequiredVisibleFraction ??
      subject.minRequiredVisibleFraction ??
      subject.minimumVisibleFraction ??
      1,
  );
  const computed = computeCropVisibility(subject);
  const headVisibleFraction = finiteNumber(
    visibility.headVisibleFraction ?? computed.headVisibleFraction,
  );
  const coreVisibleFraction = finiteNumber(
    visibility.coreVisibleFraction ?? computed.coreVisibleFraction,
  );
  const cropped =
    visibility.cropped === true ||
    visibility.headCropped === true ||
    visibility.coreCropped === true ||
    headVisibleFraction < minRequired ||
    coreVisibleFraction < minRequired;

  if (!Number.isFinite(headVisibleFraction) || !Number.isFinite(coreVisibleFraction)) {
    return {
      status: 'BLOCKED',
      minRequired,
      headVisibleFraction,
      coreVisibleFraction,
      missingEvidence: [
        'visualSubjects.visibility.headVisibleFraction',
        'visualSubjects.visibility.coreVisibleFraction',
        'visualSubjects.subjectBounds.head/core',
        'visualSubjects.frame.fit',
      ],
    };
  }

  return {
    status: cropped ? 'FAIL' : 'PASS',
    minRequired,
    headVisibleFraction,
    coreVisibleFraction,
    visibleRect: computed.visibleRect,
  };
}

function visualSubjectIssue(screen, artifact, subject) {
  const assessment = assessVisualSubjectCrop(subject);
  const subjectLabel = subjectLabelFor(subject);
  const sourcePointer = `codex_product_review.json:screens:${screen.id}:quantitative_crop_contract`;
  const evidencePointer = `screen_artifacts/${screen.id}.json:visualSubjects:${subject.id ?? subject.messageId ?? subject.subjectId ?? 'unknown'}`;
  const observed =
    `${screen.screenshot} ${subjectLabel} crop contract: ` +
    `fit=${subject.frame?.fit ?? 'unknown'}, ` +
    `headVisibleFraction=${formatNumber(assessment.headVisibleFraction)}, ` +
    `coreVisibleFraction=${formatNumber(assessment.coreVisibleFraction)}, ` +
    `minRequired=${formatNumber(assessment.minRequired)}.`;

  if (assessment.status === 'BLOCKED') {
    return [
      blockedIssue({
        id: `${screen.id}.${subjectKey(subject)}.quantitative_crop_contract`,
        source: 'product_review',
        targetType: 'screen',
        targetId: screen.id,
        screenshot: screen.screenshot,
        severity: 'P2',
        category: 'quantitative_crop_contract',
        ruleId: 'quantitative_crop_contract',
        observed: `${observed} head/core visible fraction 또는 bounds metadata가 부족해 이미지 감상으로 대신 판정하지 않는다.`,
        expected: `${subjectLabel}는 head/core visible fraction 수치로 crop 여부를 판정해야 한다.`,
        missingEvidence: assessment.missingEvidence,
        requiredArtifact: ['screen_artifacts.json', `screen_artifacts/${screen.id}.json`],
        blockedReason: '정량 crop metadata가 없어 이미지 캡처를 보고 캐릭터 crop을 추정하지 않는다.',
        passCondition:
          'headVisibleFraction과 coreVisibleFraction이 각각 minRequired 이상이어야 한다.',
        recommendedFix: '앱 QA snapshot에 subject bounds, frame fit, visible fraction metadata를 기록한다.',
        sourcePointer,
        evidencePointer,
      }),
    ];
  }

  if (assessment.status === 'FAIL') {
    return [
      normalizeQaIssue({
        id: `${screen.id}.${subjectKey(subject)}.quantitative_crop_contract`,
        source: 'product_review',
        target_type: 'screen',
        target_id: screen.id,
        status: 'FAIL',
        severity: 'P1',
        category: 'quantitative_crop_contract',
        rule_id: 'quantitative_crop_contract',
        evidence: {
          screenshot: screen.screenshot,
          observed,
        },
        expected: `${subjectLabel}의 머리와 핵심 실루엣은 minRequired 이상 화면에 노출되어야 한다.`,
        recommended_fix:
          '해당 이미지의 frame fit, alignment, 카드 비율 또는 asset bounds를 조정해 head/core visible fraction을 기준 이상으로 올린다.',
        pass_condition:
          'headVisibleFraction과 coreVisibleFraction이 각각 minRequired 이상이어야 한다.',
        regression_lock: false,
        source_pointer: sourcePointer,
        evidence_pointer: evidencePointer,
      }),
    ];
  }

  return [
    passIssue({
      id: `${screen.id}.${subjectKey(subject)}.quantitative_crop_contract`,
      source: 'product_review',
      targetType: 'screen',
      targetId: screen.id,
      screenshot: screen.screenshot,
      severity: 'P3',
      category: 'quantitative_crop_contract',
      ruleId: 'quantitative_crop_contract',
      observed,
      expected: `${subjectLabel}의 머리와 핵심 실루엣은 정량 crop 기준을 통과해야 한다.`,
      passCondition:
        'headVisibleFraction과 coreVisibleFraction이 각각 minRequired 이상이어야 한다.',
      passEvidence: observed,
      sourcePointer,
      evidencePointer,
    }),
  ];
}

function computeCropVisibility(subject) {
  const bounds = subject.subjectBounds ?? {};
  const visibleRect = visibleRectForSubject(subject);
  if (!visibleRect) {
    return {
      headVisibleFraction: Number.NaN,
      coreVisibleFraction: Number.NaN,
      visibleRect: null,
    };
  }
  return {
    headVisibleFraction: visibleFraction(bounds.head, visibleRect),
    coreVisibleFraction: visibleFraction(bounds.core, visibleRect),
    visibleRect,
  };
}

function visibleRectForSubject(subject) {
  const frame = subject.frame ?? {};
  const fit = String(frame.fit ?? '').toLowerCase();
  if (fit === 'contain') return FULL_RECT;
  if (fit !== 'cover') return null;

  const source = subject.sourceSize ?? {};
  const sourceAspectRatio = finiteNumber(
    frame.sourceAspectRatio ?? source.width / source.height,
  );
  const containerAspectRatio = finiteNumber(frame.containerAspectRatio);
  if (
    !Number.isFinite(sourceAspectRatio) ||
    !Number.isFinite(containerAspectRatio) ||
    sourceAspectRatio <= 0 ||
    containerAspectRatio <= 0
  ) {
    return null;
  }

  const alignment = String(frame.alignment ?? 'center').toLowerCase();
  if (containerAspectRatio > sourceAspectRatio) {
    const visibleHeight = clamp01(sourceAspectRatio / containerAspectRatio);
    return {
      x: 0,
      y: alignedOffset(1 - visibleHeight, alignment, 'y'),
      width: 1,
      height: visibleHeight,
    };
  }
  if (containerAspectRatio < sourceAspectRatio) {
    const visibleWidth = clamp01(containerAspectRatio / sourceAspectRatio);
    return {
      x: alignedOffset(1 - visibleWidth, alignment, 'x'),
      y: 0,
      width: visibleWidth,
      height: 1,
    };
  }
  return FULL_RECT;
}

function visibleFraction(bounds, visibleRect) {
  if (!bounds || !visibleRect) return Number.NaN;
  const rect = normalizeRect(bounds);
  if (!rect) return Number.NaN;
  const intersection = intersect(rect, visibleRect);
  const area = rect.width * rect.height;
  if (area <= 0) return Number.NaN;
  return round(intersection.width * intersection.height / area);
}

function intersect(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return {
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1),
  };
}

function normalizeRect(rect) {
  const x = finiteNumber(rect.x);
  const y = finiteNumber(rect.y);
  const width = finiteNumber(rect.width);
  const height = finiteNumber(rect.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function alignedOffset(extra, alignment, axis) {
  if (extra <= 0) return 0;
  if (axis === 'y') {
    if (alignment.includes('top')) return 0;
    if (alignment.includes('bottom')) return extra;
  }
  if (axis === 'x') {
    if (alignment.includes('left') || alignment.includes('start')) return 0;
    if (alignment.includes('right') || alignment.includes('end')) return extra;
  }
  return extra / 2;
}

function visualSubjectsForArtifact(artifact) {
  return [
    ...(Array.isArray(artifact.visualSubjects) ? artifact.visualSubjects : []),
    ...(Array.isArray(artifact.sceneContract?.visualSubjects)
      ? artifact.sceneContract.visualSubjects
      : []),
  ].filter((subject, index, subjects) => {
    const key = subjectKey(subject);
    return key && subjects.findIndex((candidate) => subjectKey(candidate) === key) === index;
  });
}

function visibleGuardianIds(artifact) {
  return uniqueStrings(
    (artifact.renderedGuardians ?? [])
      .filter((guardian) => guardian.visible !== false)
      .map((guardian) => guardian.guardianId ?? guardian.id),
  );
}

function setMismatch(expected, actual) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((id) => !actualSet.has(id)),
    unexpected: actual.filter((id) => !expectedSet.has(id)),
  };
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values ?? []) {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function subjectKey(subject) {
  return String(subject.id ?? subject.messageId ?? subject.subjectId ?? 'subject')
    .replace(/[^a-zA-Z0-9_.:-]+/g, '_');
}

function subjectLabelFor(subject) {
  const subjectId = subject.subjectId ?? subject.id ?? 'unknown_subject';
  const messageId = subject.messageId ? `/${subject.messageId}` : '';
  return `${subject.kind ?? 'visualSubject'}:${subjectId}${messageId}`;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(round(value)) : 'metadata 없음';
}
