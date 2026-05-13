# QA-Dragonout 코드 레벨 contract와 정량 이미지 판정 PLAN

문서 상태: active  
최종 갱신: 2026-05-13  
대상 스펙: `SPEC.md`

## 1. 준비

- `/Users/euna/Developer/QA-Dragonout`와 `/Users/euna/Developer/Dragonout`의 git 상태를 확인한다.
- 작업 브랜치는 `feature/quantitative-qa-contracts`를 사용한다.
- GitHub issue 생성은 인증 만료로 보류하고 `LOCAL-QA-001`로 로컬 추적한다.

## 2. Red

- speaker expected/actual id mismatch가 FAIL이 되는 fixture를 추가한다.
- visitor head/core visible fraction 미달이 FAIL이 되는 fixture를 추가한다.
- metadata가 부족하면 BLOCKED가 되는 fixture를 추가한다.

## 3. Green

- `qa_capture_chrome.mjs`가 `sceneContract`와 `visualSubjects`를 screen artifact에 기록하게 한다.
- 정량 contract evaluator를 추가한다.
- `qa_write_current_reviews.mjs`에서 evaluator 결과를 product screen `qa_issues`에 합친다.
- evidence는 expected/actual id, fit, visible fraction, bounds를 한국어 문장으로 남긴다.

## 4. Refactor

- crop 계산은 helper 함수로 분리한다.
- 기존 guardian matrix 판정은 유지하되, `sceneContract`가 있으면 새 코드 레벨 contract를 우선 근거로 사용한다.
- 이미지 기반 정성 판단 문구가 새 contract path에 들어가지 않게 테스트한다.

## 5. 검증

- `node tools/qa_quantitative_contracts_tests.mjs`
- `node tools/qa_validate_report_tests.mjs`
- 필요 시 기존 runner/client 단위 테스트는 추가 실행한다.

## 6. 완료

- `TODO.md`의 `LOCAL-QA-001` 항목은 구현과 테스트가 끝난 뒤에만 체크한다.
- 최종 보고에 변경 파일, 테스트 결과, 미실행 QA와 사유를 기록한다.
