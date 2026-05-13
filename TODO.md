# QA-Dragonout 코드 레벨 contract와 정량 이미지 판정 TODO

문서 상태: active  
최종 갱신: 2026-05-13

## 현재 진행 작업

- [ ] LOCAL-QA-001 [QA] 코드 레벨 화면 contract와 정량 이미지 판정 전환
  - 추적 이슈: GitHub issue 생성 대기. 현재 GitHub 인증 만료(`token_expired`)로 원격 이슈 발행이 막혀 로컬 TODO로 추적한다.
  - 목표: speaker/visible character mismatch를 이미지 분석이 아니라 screen artifact id set 비교로 판정한다.
  - 목표: visitor/portrait crop을 head/core visible fraction 수치로 판정한다.
  - 목표: contract metadata 부족은 감상형 PASS가 아니라 `BLOCKED`로 남긴다.
  - 잔여: `node tools/qa_validate_report_tests.mjs`가 기존 fixed QA rule fixture 기대값 8건에서 실패한다. 새 정량 contract 단위 테스트는 통과했다.

## 작업 항목

- [x] `qa_capture_chrome.mjs`가 `sceneContract`와 `visualSubjects`를 artifact에 보존한다.
- [x] 정량 contract evaluator를 추가한다.
- [x] product review 생성 시 evaluator 결과를 `qa_issues`에 합친다.
- [x] speaker mismatch red fixture를 추가한다.
- [x] visitor crop red fixture를 추가한다.
- [x] metadata 부족 BLOCKED fixture를 추가한다.
- [x] 정상 contract PASS fixture를 추가한다.
- [x] `node tools/qa_quantitative_contracts_tests.mjs`를 실행한다.
- [ ] `node tools/qa_validate_report_tests.mjs`를 실행한다.
  - 결과: 8건 실패. 실패 사유는 `guardian_presence_exact`, `guardian_portrait_scale_consistency`, `guardian_portrait_no_crop`, `decorative_chrome_no_text_overlap` 관련 기존 fixture 기대값 불일치다.
