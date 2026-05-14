# QA-Dragonout M3 guardian portrait QA TODO

문서 상태: active  
최종 갱신: 2026-05-14

## 현재 진행 작업

- [ ] #15 [M3] guardian portrait QA 계약 정량화와 출시 품질 검증 구조 정리
  - 목표: M3 출시 후보 guardian portrait와 Live2D-like 기준을 canonical QA runner의 matrix/fixed rule/검증 로직에 반영한다.
  - 목표: motion artifact 요구를 실제 matrix screen id 기반으로 계산해 새 화면 확장과 반복 검증이 쉽도록 한다.
  - 목표: Dragonout target Fast QA와 Full QA에서 같은 M3 기준이 적용되게 한다.

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
