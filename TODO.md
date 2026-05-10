# QA-Dragonout 엔딩 QA 룰 및 자동 검출 강화 TODO

## 준비

- [ ] `QA-Dragonout`와 `Dragonout`의 git 상태를 확인한다.
- [ ] Dragonout 앱 repo 변경용 task worktree와 `codex/qa-ending-rules` 브랜치를 준비한다.
- [ ] 64700 Dashboard 상태를 `doctor`로 확인하고 stale/noncanonical 서버가 있으면 PID와 cwd를 기록한다.

## Canonical QA 설정

- [ ] `QA-Dragonout/tools/qa_matrix.json` canonical 사본을 추가한다.
- [ ] `QA-Dragonout/tools/qa_playthrough_matrix.json` canonical 사본을 추가한다.
- [ ] `QA-Dragonout/tools/qa_fixed_rules.json` canonical 사본을 추가한다.
- [ ] Dragonout task worktree의 `tools/qa_*.json`을 canonical 사본과 동기화한다.
- [ ] runner/client 기본 canonical 경로를 `/Users/euna/Developer/QA-Dragonout`로 변경한다.
- [ ] README와 테스트 fixture에서 `Dragonout-qa-runner` 잔여 기본값을 제거한다.

## 엔딩 QA 판정 항목

- [ ] `ending_cycle1`에 `ending_guardian_portrait_no_crop` 판정 항목을 추가한다.
- [ ] `ending_cycle1`에 `ending_resource_badge_clarity` 판정 항목을 추가한다.
- [ ] `ending_cycle1`에 `ending_lock_unlock_state_clarity` 판정 항목을 추가한다.
- [ ] `ending_cycle1`에 `ending_badge_overdensity` 판정 항목을 추가한다.
- [ ] `ending_cycle2`에 같은 네 판정 항목을 추가한다.
- [ ] `ending_cycle3`에 같은 네 판정 항목을 추가한다.
- [ ] `qa_fixed_rules.json`에 `ending_guardian_portrait_no_crop` 고정 룰을 추가한다.
- [ ] `qa_fixed_rules.json`에 `ending_resource_badge_clarity` 고정 룰을 추가한다.
- [ ] `qa_fixed_rules.json`에 `ending_lock_unlock_state_clarity` 고정 룰을 추가한다.
- [ ] `qa_fixed_rules.json`에 `ending_badge_overdensity` 고정 룰을 추가한다.
- [ ] 세 엔딩 flow의 required evidence에 새 엔딩 판정 증거를 추가한다.

## 자동 검출

- [ ] PNG 분석 metrics에 밝은 저채도 connected component 개수, 군집 수, 위치 샘플을 추가한다.
- [ ] `qa_polish_lints.mjs`에 `white_bitmap_badge` finding을 추가한다.
- [ ] `qa_polish_lints.mjs`에 `resource_badge_cluster_density` finding을 추가한다.
- [ ] `qa_polish_lints.mjs`에 `badge_overdensity` finding을 추가한다.
- [ ] `qa_capture_chrome.mjs`가 visible text, button/aria-label/role, img src/asset path, bounds metadata를 `capture_result.json`에 저장하게 한다.
- [ ] lock/unlock 의미 증거가 부족하면 `BLOCKED` QA 판정 항목으로 변환한다.
- [ ] guardian/ending portrait safeArea bounds가 없으면 크롭 룰을 `BLOCKED`로 남긴다.
- [ ] bounds가 있고 safeArea 침범이 관찰되면 크롭 룰을 `FAIL`로 남긴다.

## Dashboard와 Report

- [ ] 새 엔딩 룰이 Dashboard 카드의 단일 `QA 판정 항목` 목록에 표시되는지 확인한다.
- [ ] 새 엔딩 룰이 HTML report의 `전체 QA 판정 항목`에 표시되는지 확인한다.
- [ ] 계약 위반/증거 부족 별도 블록이 다시 생기지 않았는지 확인한다.
- [ ] 사용자-facing 판정 근거가 한국어인지 확인한다.

## 테스트

- [ ] `node tools/qa_plan_run_tests.mjs`를 실행한다.
- [ ] `node tools/qa_validate_report_tests.mjs`를 실행한다.
- [ ] `node tools/qa_runner_server_tests.mjs`를 실행한다.
- [ ] `node tools/qa_dashboard_client_tests.mjs`를 실행한다.
- [ ] Dragonout task worktree에서 `flutter analyze`를 실행한다.
- [ ] Dragonout task worktree에서 `flutter test`를 실행한다.
- [ ] 중앙 runner 경유 Fast 또는 Full QA를 실행한다.

## 완료 보고

- [ ] `SPEC.md` 요구사항 충족 여부를 확인한다.
- [ ] `PLAN.md` 실행 항목 준수 여부를 확인한다.
- [ ] 변경 파일, 테스트 결과, 미실행 테스트와 사유를 최종 보고에 정리한다.
- [ ] Dragonout task worktree path와 branch name을 보고한다.
