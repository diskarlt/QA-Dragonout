# QA-Dragonout M3 guardian portrait 출시 품질 QA SPEC

문서 상태: active  
최종 갱신: 2026-05-14  
대상 작업: GitHub issue #15

## 목적

QA-Dragonout이 Dragonout M3 출시 후보 빌드의 guardian portrait와 Live2D-like 품질을 정량 contract로 반복 검증한다. 정식 Live2D 런타임, mouth animation, 4명 전원 rigging은 이번 QA 계약의 PASS 요구가 아니며, Flutter-only pseudo-Live2D 연출과 화면별 crop/name/background 안전성을 출시 품질 기준으로 본다.

## 요구사항

- Dragonout의 M3 `tools/qa_matrix.json`와 `tools/qa_fixed_rules.json` 기준을 canonical runner에 반영한다.
- guardian portrait가 나오는 화면은 이름-초상 일치, crop, scale, safe area, 배경 구분을 화면 artifact와 matrix criterion으로 판정한다.
- motion evidence는 matrix가 실제 화면 id에 요구한 경우에만 필요하다. 개념 target이나 문서용 umbrella rule이 motion artifact를 강제로 요구하면 안 된다.
- pseudo-Live2D PASS는 2초 영상 또는 3 timestamp frame에서 idle float, breathing scale, glow/aura, default/fatigued/low_bond 톤 중 하나 이상의 안정적 변화가 확인되는 경우로 제한한다.
- blink/overlay가 전체 이미지를 깜빡이게 하거나 눈/입 외 영역을 덮는 상태는 화면별 forbidden criterion으로 FAIL 또는 BLOCKED 근거를 남긴다.
- QA 판정과 queue 산출물은 한국어 근거, rule id, artifact pointer, 정량 수치를 함께 남긴다.
- capture pipeline은 Dragonout `window.__QA_SNAPSHOT__`의 `portraitBounds`, `safeArea`, `faceScale`, `eyeMidpointDeltaPx`, `projectedHeadTopPx`를 `screen_artifacts`까지 보존한다.
- 새 화면과 새 image subject를 추가할 때 matrix criterion, screen artifact, motion artifact 요구 여부를 분리해 확장할 수 있어야 한다.
- runner는 active job의 `lastHeartbeatAt`, `stale`, `childProgress`를 노출해 장시간 실행과 정지 상태를 구분할 수 있어야 한다.
- capture 중 live status 갱신은 빠른 JSON write로 제한하고, HTML report 생성은 runner의 report generation 단계에서 한 번 수행한다.
- 하위 프로세스가 timeout을 넘기거나 취소되면 runner가 SIGTERM/SIGKILL 정리와 부분 artifact 저장을 수행한다.

## 제외

- Dragonout 이미지 asset 생성 또는 리깅 제작.
- 정식 Live2D 런타임 도입, mouth animation, 4명 전원 rigging 구현.
- AI 감상평 기반 PASS 선언.
- QA-Dragonout 외부의 앱 코드를 runner에서 직접 수정하는 작업.

## 성공 기준

- `node tools/qa_quantitative_contracts_tests.mjs`가 통과한다.
- `node tools/qa_validate_report_tests.mjs`가 통과한다.
- M3 matrix 기준으로 motion artifact 필수 화면이 base_status, event_choice_enabled, event_choice_disabled, result처럼 실제 matrix screen id에만 계산된다.
- Full QA report가 guardian portrait crop/scale PASS를 semantic fallback이 아니라 numeric metric 근거로 기록한다.
- Dragonout target Fast QA와 Full QA에서 M3 guardian portrait 기준이 적용되고 FAIL/BLOCKED가 발견되면 수정 큐로 이어진다.
- `node tools/qa_runner_server_tests.mjs`와 `node tools/qa_dashboard_client_tests.mjs`가 stale active job 진단과 canonical runner 동작을 검증한다.
- PR에는 issue #15와 실행한 테스트/QA 결과를 연결한다.
