# QA-Dragonout 코드 레벨 contract와 정량 이미지 판정 SPEC

문서 상태: active  
최종 갱신: 2026-05-13  
대상 작업: `LOCAL-QA-001`

## 목적

QA-Dragonout이 Dragonout 화면을 캡처 이미지의 정성 평가로 판정하지 않고, 앱이 노출한 `sceneContract`와 정량 metadata를 기준으로 화면별 QA 판정을 만든다. 대화 화면은 scene/dialogue speaker와 실제 visible character id를 비교하고, 이미지 crop은 대상 subject의 head/core visible fraction과 bounds를 비교한다.

## 요구사항

- `qa_capture_chrome.mjs`는 `window.__QA_SNAPSHOT__.sceneContract`와 `visualSubjects`를 screen artifact에 보존한다.
- speaker/portrait 검증은 이미지 내용 분석이 아니라 다음 metadata만 사용한다.
  - expected visible character id set
  - active speaker id set
  - rendered guardian id set
  - snapshot source와 metadata quality
- crop 검증은 이미지 감상 문구를 쓰지 않고 다음 수치만 사용한다.
  - source size
  - normalized head/core bounds
  - frame fit과 alignment
  - head/core visible fraction
  - minimum required visible fraction
- `qa_write_current_reviews.mjs`는 mismatch와 crop 미달을 `FAIL`, metadata 부족을 `BLOCKED`, 수치 충족을 `PASS`로 변환한다.
- 사용자-facing QA evidence는 한국어로 쓰되, id와 수치는 원문을 유지한다.

## 제외

- AI 이미지 분석, OCR 기반 캐릭터 판별, “어울림/퀄리티” 같은 감상형 판정.
- Dragonout asset 생성 또는 교체.
- 중앙 Dashboard full job 자동 실행.
- GitHub issue/PR 원격 생성. 현재 인증 만료로 로컬 추적한다.

## 성공 기준

- speaker mismatch fixture가 product review `FAIL`로 승격된다.
- visitor crop fixture가 visible fraction 수치와 함께 product review `FAIL`로 승격된다.
- 올바른 speaker/crop metadata fixture는 `PASS`로 유지된다.
- `node tools/qa_quantitative_contracts_tests.mjs`가 통과한다.
- `node tools/qa_validate_report_tests.mjs`가 통과한다.
