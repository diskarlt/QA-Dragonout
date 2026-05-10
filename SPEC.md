# QA-Dragonout 엔딩 QA 룰 및 자동 검출 강화 SPEC

## 목적

QA-Dragonout을 Dragonout QA 도구의 canonical runner로 고정하고, 엔딩 화면에서 누락된 QA 판정 항목을 강화한다. 특히 엔딩/회차 결산 화면에서 캐릭터 머리와 핵심 실루엣 크롭, 자원/해금 정보가 흰 배지처럼 보이는 문제, 자물쇠/해금 아이콘의 의미 불명확, 엔딩 정보 과밀을 QA Matrix와 Dashboard에 명시적인 판정 항목으로 남긴다.

## 요구사항

- QA 설정은 양쪽 동기화 정책을 따른다.
  - `QA-Dragonout`이 canonical QA runner와 canonical QA 설정 사본을 가진다.
  - Dragonout 앱 repo의 `tools/qa_matrix.json`, `tools/qa_playthrough_matrix.json`, `tools/qa_fixed_rules.json`은 호환용 동기화 사본으로 유지한다.
- QA runner 기본 canonical 경로는 `/Users/euna/Developer/QA-Dragonout`이어야 한다.
  - `Dragonout-qa-runner` 잔여 기본값은 제거한다.
  - `/api/health`와 `doctor`는 `runnerRoot=/Users/euna/Developer/QA-Dragonout`, `isCanonicalRunner=true`를 정상 상태로 본다.
- 엔딩 화면 QA Matrix에는 아래 판정 항목이 포함되어야 한다.
  - `ending_guardian_portrait_no_crop`: 캐릭터 머리와 핵심 실루엣이 안전영역 밖으로 잘리지 않는다.
  - `ending_resource_badge_clarity`: 자원/해금/결산 정보가 흰 비트맵 배지처럼 떠 보이지 않고 HUD 톤과 통합된다.
  - `ending_lock_unlock_state_clarity`: 잠김/해금 상태가 아이콘, 문구, 접근 가능 여부로 구분된다.
  - `ending_badge_overdensity`: 엔딩 결산 정보가 배지/수치 과밀로 읽히지 않는다.
- `qa_fixed_rules.json`에는 위 엔딩 룰이 repo-tracked 고정 QA 룰로 있어야 한다.
- `qa_playthrough_matrix.json`의 `ending_cycle1_flow`, `ending_cycle2_flow`, `ending_cycle3_flow`는 위 엔딩 룰에 필요한 evidence를 요구해야 한다.
- 자동 검출은 가능한 범위에서만 PASS/FAIL을 확정한다.
  - 흰 배지와 정보 과밀은 PNG 픽셀 분석과 capture metadata로 자동 finding을 낸다.
  - lock/unlock은 semantics, aria-label, visible text, asset path, bounding box metadata 중 하나 이상으로 의미 구분 증거를 수집한다.
  - 캐릭터 크롭은 bounds/safeArea metadata가 있으면 자동 FAIL 후보로 삼고, metadata가 없으면 무리하게 PASS하지 않고 `BLOCKED`로 남긴다.
- Dashboard와 HTML report는 사용자-facing QA Matrix 정책을 지킨다.
  - 계약 위반/증거 부족을 별도 블록으로 쪼개지 않는다.
  - 각 기준은 단일 `QA 판정 항목`으로 표시하고 `PASS`, `FAIL`, `BLOCKED`, `RULE_INVALID`, `SKIP` 상태, 관찰 근거, 통과 기준, 다음 조치를 함께 보여준다.
  - 사용자-facing 문구와 QA 판정 근거는 한국어로 작성한다.

## 범위

- 포함:
  - `QA-Dragonout` 문서, QA runner 기본 경로, canonical QA 설정 파일, 자동 lint/capture/review/validation 로직.
  - Dragonout task worktree의 동기화된 `tools/qa_*.json`.
  - QA 도구 테스트 fixture와 validation 테스트.
- 제외:
  - Dragonout 실제 UI 수정.
  - 엔딩 이미지 또는 캐릭터 asset 재생성.
  - `/Users/euna/Developer/QA-Dragonout` 삭제, 재생성, cleanup.

## 성공 기준

- `QA-Dragonout`에서 QA 도구 테스트가 통과한다.
- Dragonout task worktree에서 동기화된 QA 설정이 JSON으로 유효하다.
- 엔딩 화면과 엔딩 flow report/dashboard에 새 룰 id가 누락 없이 표시된다.
- 흰 배지 후보, lock/unlock 증거 부족, 크롭 bounds 증거 부족 fixture가 각각 `FAIL` 또는 `BLOCKED`로 검증된다.
- 최종 보고에는 변경한 repo, task worktree 경로, 변경 파일, 실행한 테스트, 미실행 테스트와 사유가 한국어로 기록된다.
