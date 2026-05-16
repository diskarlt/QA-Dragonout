# QA-Dragonout M3 guardian portrait QA TODO

문서 상태: active  
최종 갱신: 2026-05-16

## 현재 진행 작업

- [ ] #15 [M3] guardian portrait QA 계약 정량화와 출시 품질 검증 구조 정리
  - 목표: M3 출시 후보 guardian portrait와 Live2D-like 기준을 canonical QA runner의 matrix/fixed rule/검증 로직에 반영한다.
  - 목표: motion artifact 요구를 실제 matrix screen id 기반으로 계산해 새 화면 확장과 반복 검증이 쉽도록 한다.
  - 목표: Dragonout target Fast QA와 Full QA에서 같은 M3 기준이 적용되게 한다.
- [ ] #19 Scenario QA artifact와 기기별 재현 캡처 추가
  - 목표: Full QA와 별개로 흐름/화면 단위 재현 스캔을 실행한다.
  - 목표: 각 step별 screenshot, 대사 후보, CTA, 이미지 표시 근거를 artifact로 남긴다.
  - 목표: mobile/tablet 등 여러 viewport profile로 같은 화면을 캡처해 실제 기기 표현 차이를 확인한다.
- [ ] #21 Dragon Work 전용 화면 캡처를 QA matrix에 추가
  - 목표: Dragonout main의 최신 Dragon Work QA screen 계약을 canonical runner matrix에 반영한다.
  - 목표: full QA가 Dragon Work hub, 5종 play, forge result 화면까지 캡처하게 한다.
  - 목표: Dragon Work 관련 변경 파일은 fast QA에서 `dragon_work` 그룹으로 라우팅한다.

## 작업 항목

- [x] Dragonout M3 `qa_matrix.json`와 `qa_fixed_rules.json` 기준을 QA-Dragonout에 반영한다.
- [x] CAL-S02 필수 motion rule id를 `guardian_motion.pseudo_live2d_presence`로 갱신한다.
- [x] 개념 target blink overlay fixed rule을 제거하고 화면별 forbidden criterion으로 유지한다.
- [x] motion artifact 필수 화면을 matrix screen id와 motion criterion에서 계산하게 한다.
- [x] Dragonout portrait snapshot의 numeric metric을 `screen_artifacts`와 review 판정까지 보존한다.
- [x] runner active job에 heartbeat/stale/childProgress 진단 필드를 추가한다.
- [x] capture 중 live status update에서 동기식 HTML report 생성을 분리한다.
- [x] 하위 프로세스 timeout과 SIGTERM/SIGKILL 정리 경로를 추가한다.
- [x] `node tools/qa_quantitative_contracts_tests.mjs`를 실행한다.
  - 결과: PASS.
- [x] `node tools/qa_validate_report_tests.mjs`를 실행한다.
  - 결과: PASS.
- [x] `node tools/qa_runner_server_tests.mjs`를 실행한다.
  - 결과: PASS.
- [x] `node tools/qa_dashboard_client_tests.mjs`를 실행한다.
  - 결과: PASS.
- [x] Dragonout target Fast QA와 Full QA를 실행하고 FAIL/BLOCKED를 후속 수정에 연결한다.
  - 결과: Fast QA는 Dev Queue 0, QA Queue 7로 Full QA 확인 대상만 남김.
  - 결과: Full QA는 automatedGate=pass, codexReview=ready, finalStatus=pass.
- [ ] PR 생성 후 merge한다.

## #19 작업 항목

- [x] Scenario QA 전용 runner/client 명령을 추가한다.
- [x] 흐름/화면 필터와 device profile/viewport 옵션을 전달한다.
- [x] `scenario_artifacts.json`와 flow/device별 screenshot·대사·이미지 증거 artifact를 저장한다.
- [x] HTML report에 Scenario Flow QA Artifacts 섹션을 렌더링한다.
- [x] runner/client 테스트에 scenario 실행 경로를 추가한다.
- [ ] Scenario QA를 실제 Dragonout target에 실행해 artifact를 확인한다.
- [ ] #19 PR을 생성한다.

## #21 작업 항목

- [x] Dragonout main의 최신 `tools/qa_matrix.json`를 QA-Dragonout에 동기화한다.
- [x] `dragon_work_*` 화면 7개를 matrix에 포함한다.
- [x] `qa_plan_run.mjs`와 `qa_capture_chrome.mjs`에서 `dragon_work` 변경 파일을 Dragon Work fast QA group으로 라우팅한다.
- [x] 관련 node test를 실행한다.
  - 결과: `node tools/qa_plan_run_tests.mjs`, `node tools/qa_validate_report_tests.mjs`, `node tools/qa_runner_server_tests.mjs` PASS.
- [x] Dragonout target에서 Dragon Work 전용 capture를 실행해 screenshot artifact를 확인한다.
  - 결과: `fast --changed-file lib/screens/dragon_work_play_screen.dart`가 `dragon_work` 7개 화면을 선택했고 screenshot 7개와 screen artifact를 생성했다.
- [ ] #21 PR을 생성한다.
