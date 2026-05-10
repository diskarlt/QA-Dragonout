# QA-Dragonout

Dragonout 전용 QA 인프라 프로젝트. Dragonout 게임 앱과 완전히 분리된 독립 repo다.

## 역할

- `tools/qa_runner_server.mjs`: Dashboard 서버 (포트 64700 고정). 한 번 띄워두면 계속 실행.
- `tools/qa_dashboard_client.mjs`: 다른 checkout 또는 worktree에서 QA 요청을 위임할 때 사용.
- `reports/current/`: QA 산출물 저장 위치. git 추적 안 함.

앱 특화 파일(qa_matrix.json, qa_playthrough_matrix.json, qa_fixed_rules.json)은
**Dragonout 앱 repo**의 `tools/`에 있다. 서버는 `QA_TARGET_WORKTREE`로 지정된
Dragonout 작업 checkout 또는 worktree에서 이 파일들을 읽는다.

## 서버 시작

```sh
cd /Users/euna/Developer/QA-Dragonout
node tools/qa_runner_server.mjs
```

포트 충돌 시:

```sh
QA_DASHBOARD_PORT=64701 node tools/qa_runner_server.mjs
```

Dashboard URL: `http://127.0.0.1:64700`

## 헬스체크 (다른 checkout/worktree에서)

```sh
node /Users/euna/Developer/QA-Dragonout/tools/qa_dashboard_client.mjs doctor
```

`stale_or_noncanonical_server`가 뜨면 64700을 점유한 구 프로세스의 PID·cwd를 확인 후
명시적 승인을 받아 종료하고 서버를 재시작한다. client가 자동으로 kill하지 않는다.

## 다른 checkout/worktree에서 QA 실행

```sh
# 상태 확인
node /Users/euna/Developer/QA-Dragonout/tools/qa_dashboard_client.mjs status

# Fast QA (변경 파일 기준 영향 화면만)
node /Users/euna/Developer/QA-Dragonout/tools/qa_dashboard_client.mjs fast \
  --target "$PWD" --changed-file lib/ui/hud.dart

# Full QA (main 병합 전 필수)
node /Users/euna/Developer/QA-Dragonout/tools/qa_dashboard_client.mjs full \
  --target "$PWD"

# 보고서만 재생성
node /Users/euna/Developer/QA-Dragonout/tools/qa_dashboard_client.mjs refresh \
  --target "$PWD"
```

## 관련 문서

- QA 전체 구조: Dragonout의 `docs/qa/overview.md`
- 품질 기준: Dragonout의 `docs/qa/quality_bar.md`
- 명령어 레퍼런스: Dragonout의 `docs/07_manual_qa.md`
