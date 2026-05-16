# QA-Dragonout M3 guardian portrait 출시 품질 QA PLAN

문서 상태: active  
최종 갱신: 2026-05-16
대상 스펙: `SPEC.md`

## 1. 준비

- `/Users/euna/Developer/QA-Dragonout`와 `/Users/euna/Developer/Dragonout`의 git 상태를 확인한다.
- #21 작업 브랜치는 `feature/21-dragon-work-captures`를 사용한다.
- 추적 이슈는 GitHub issue #21을 사용한다.

## 2. M3 계약 반영

- Dragonout M3 기준의 `qa_matrix.json`와 `qa_fixed_rules.json`를 canonical runner에 동기화한다.
- `guardian_motion.pseudo_live2d_presence`를 CAL-S02 필수 룰로 사용하고, 과거 underscore id는 호환 alias로만 처리한다.
- `guardian_blink_overlay_outside_face`는 화면별 forbidden criterion으로 두고 fixed rule에서는 제거한다.

## 3. 검증 구조 정리

- CAL-S02 필수 rule 목록은 `qa_queue_model.mjs`의 단일 목록에서 재사용한다.
- motion artifact 요구 화면은 matrix의 실제 screen id와 motion criterion에서 계산한다.
- fixed rule의 target이 matrix screen id가 아니면 motion artifact 필수 화면으로 추가하지 않는다.
- capture/review 경로는 Dragonout snapshot의 `portraitBounds`, `safeArea`, `faceScale`, `eyeMidpointDeltaPx`, `projectedHeadTopPx`를 보존하고, semantic fallback만으로 crop/scale PASS를 선언하지 않는다.
- 테스트 fixture는 M3 dot id와 Flutter-only pseudo-Live2D 문구를 기준으로 갱신한다.
- runner status는 `elapsedMs`, `lastHeartbeatAt`, `stale`, `childProgress`를 노출해 캡처가 실제 정지했는지 판단 가능하게 한다.
- `qa_capture_chrome.mjs`의 live status update는 `--generate 0`으로 JSON만 갱신하고, HTML report 생성은 runner의 report 단계로 모은다.
- `runProcessStep`은 단계 timeout과 SIGTERM/SIGKILL 정리를 수행하고, `qa_capture_chrome.mjs`는 SIGTERM/SIGINT 시 Chrome과 임시 profile을 정리한다.

## 4. 검증

- `node tools/qa_quantitative_contracts_tests.mjs`
- `node tools/qa_validate_report_tests.mjs`
- `node tools/qa_runner_server_tests.mjs`
- `node tools/qa_dashboard_client_tests.mjs`
- Dragonout target에 대해 Fast QA 후 Full QA를 실행한다.

## 5. 완료

- QA-Dragonout 변경을 커밋하고 PR을 열어 issue #15와 연결한다.
- 테스트와 QA가 PASS이면 PR을 merge한다.
- Dragonout PR의 Full QA 근거와 동일한 M3 기준을 최종 보고에 함께 남긴다.

## 6. Dragon Work 화면 캡처 추가

- Dragonout main의 최신 `tools/qa_matrix.json`를 canonical runner에 동기화해 `dragon_work_*` 화면 7개를 추가한다.
- `qa_plan_run.mjs`와 `qa_capture_chrome.mjs`에서 `dragon_work` 경로 변경을 `dragon_work` fast QA group으로 선택한다.
- `node tools/qa_plan_run_tests.mjs`로 fast plan과 full screen count 32개를 확인한다.
- Dragonout target에서 `dragon_work` group capture를 실행해 전용 screenshot과 screen artifact가 생성되는지 확인한다.
- #21 PR에는 `Closes #21`과 실행한 node test/QA 결과를 남긴다.
