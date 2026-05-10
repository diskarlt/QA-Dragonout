# QA-Dragonout 엔딩 QA 룰 및 자동 검출 강화 PLAN

## 실행 원칙

- 구현 전 `SPEC.md`와 `PLAN.md`를 현재 작업의 source of truth로 사용한다.
- Dragonout 앱 repo 변경은 `/Users/euna/Developer/Dragonout` 원본이 아니라 별도 task worktree에서만 수행한다.
- `QA-Dragonout`은 독립 repo이므로 직접 수정하되, `/Users/euna/Developer/QA-Dragonout` 자체를 삭제하거나 재생성하지 않는다.
- 코드와 QA 산출물의 사용자-facing 판정 문구는 한국어로 작성한다.

## 1. 준비

- `/Users/euna/Developer/QA-Dragonout`와 `/Users/euna/Developer/Dragonout`의 `git status --short --branch`를 확인한다.
- Dragonout 원본 worktree에 사용자 변경이 있으면 건드리지 않는다.
- Dragonout 쪽 설정 동기화가 필요하면 `../Dragonout-task-qa-ending-rules` 형태의 task worktree와 `codex/qa-ending-rules` 브랜치를 사용한다.
- 기존 64700 서버는 `doctor`로 확인한다. stale 또는 noncanonical이면 PID와 cwd를 보고하고, 자동 종료하지 않는다.

## 2. QA-Dragonout canonical 설정 추가

- `QA-Dragonout/tools/qa_matrix.json`, `qa_playthrough_matrix.json`, `qa_fixed_rules.json`을 canonical 사본으로 추가한다.
- Dragonout 앱 repo의 기존 `tools/qa_*.json`을 출발점으로 삼되, 엔딩 룰 보강 후 양쪽 파일 내용이 동기화되게 한다.
- runner와 client의 기본 canonical 경로를 `/Users/euna/Developer/QA-Dragonout`로 변경한다.
- README와 필요 시 테스트 fixture에서 `Dragonout-qa-runner` 잔여 기본값을 제거한다.

## 3. 엔딩 QA 룰 강화

- `ending_cycle1`, `ending_cycle2`, `ending_cycle3`에 아래 항목을 추가한다.
  - `ending_guardian_portrait_no_crop`
  - `ending_resource_badge_clarity`
  - `ending_lock_unlock_state_clarity`
  - `ending_badge_overdensity`
- 각 항목은 `expected`, `implementedEvidence`, `forbidden`, `contractChecks`, `failIfMissing`, `failIfPresent` 중 알맞은 위치에 반영한다.
- `qa_fixed_rules.json`에 동일한 룰 id의 고정 룰을 추가하고, 관찰 근거/통과 기준/권장 수정은 실제 QA 판정 가능한 한국어 문장으로 작성한다.
- `qa_playthrough_matrix.json`의 세 엔딩 flow required evidence에 portrait crop, badge clarity, lock/unlock clarity, ending density review를 추가한다.

## 4. 자동 검출 설계 구현

- `qa_lib.mjs`와 `qa_polish_lints.mjs`를 확장해 밝은 저채도 connected component의 개수, 군집 수, 위치 샘플을 metrics로 남긴다.
- lint finding code를 추가한다.
  - `white_bitmap_badge`
  - `resource_badge_cluster_density`
  - `badge_overdensity`
- `qa_capture_chrome.mjs`에서 화면별 metadata를 capture_result에 저장한다.
  - visible text 요약
  - button/aria-label/role
  - img src 또는 asset path 후보
  - lock/unlock/resource 관련 element bounds
- `qa_write_current_reviews.mjs` 또는 queue model에서 metadata가 충분하면 FAIL/PASS 근거로, 부족하면 `BLOCKED` 근거로 변환한다.
- 크롭 판정은 bounds/safeArea metadata가 있을 때만 자동 FAIL 또는 PASS 후보로 삼고, 없으면 `BLOCKED`로 남긴다.

## 5. 검증 보강

- `qa_validate_report_tests.mjs`에 실패 fixture를 추가한다.
  - 엔딩 화면에 새 portrait crop 룰이 없으면 validation 실패.
  - 엔딩 flow에 새 fixed rule id가 report/dashboard에 없으면 validation 실패.
  - lock/unlock 의미 증거가 없으면 `BLOCKED` 또는 validation 실패.
- `qa_runner_server_tests.mjs`와 `qa_dashboard_client_tests.mjs`에서 canonical root 기본값이 `/Users/euna/Developer/QA-Dragonout`임을 확인한다.
- `qa_polish_lints` fixture 또는 단위 테스트로 흰 배지 후보 임계값을 확인한다.

## 6. 실행할 테스트

- QA-Dragonout:
  - `node tools/qa_plan_run_tests.mjs`
  - `node tools/qa_validate_report_tests.mjs`
  - `node tools/qa_runner_server_tests.mjs`
  - `node tools/qa_dashboard_client_tests.mjs`
- Dragonout task worktree:
  - `flutter analyze`
  - `flutter test`
  - 중앙 runner 경유 Fast 또는 Full QA

## 7. 완료 확인

- `SPEC.md` 요구사항과 `PLAN.md` 실행 항목을 대조한다.
- QA Dashboard `/api/status`가 `runnerRoot`, `targetWorktree`, `reportDir`, `screenshotDir`를 분리해서 표시하는지 확인한다.
- 최종 보고에 SPEC/PLAN 검증 결과, 변경 파일, 테스트 결과, 미해결 blocker를 기록한다.
