# QA-Dragonout Agent Guardrails

## Branch and PR Policy

QA-Dragonout work should happen on a dedicated task branch in the current `/Users/euna/Developer/QA-Dragonout` checkout by default.

- Before making repo-tracked edits, inspect the current workspace with `git status --short --branch`.
- If the workspace is clean and the task requires repo-tracked edits, create or switch to a dedicated task branch with:

  ```sh
  git switch -c feature/<short-name>
  ```

- Development work must be tracked through a GitHub issue. Pure documentation-only guardrail updates, typo fixes, and small explanatory edits that do not change code behavior or verification flow do not require an issue.
- Task branches and PR descriptions must reference the related issue number for development work.
- Open a PR after the required tests and checks pass. Do not merge directly into `main` or push `main` as the default completion flow.
- If the current checkout is dirty before a task starts, assume the changes belong to the user or another concurrent task and ask before creating a branch or editing files.

## QA Runner Safety

`/Users/euna/Developer/QA-Dragonout` is the persistent canonical QA runner project for Dragonout.

- Port `64700` is reserved for this runner.
- Do not delete, recreate, prune, or clean this repository unless the user explicitly names this exact path and asks for that destructive action in the same turn.
- Dragonout app branches or worktrees may be QA targets, but they must delegate to this central runner instead of binding the Dashboard port themselves.
