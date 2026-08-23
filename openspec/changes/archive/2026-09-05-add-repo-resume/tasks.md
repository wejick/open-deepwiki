## 1. Pipeline: `resumeRepo`

- [x] 1.1 Extract the pinned-target run body shared by `updateRepo` into a private helper in `src/repoManager/pipeline.ts`; `updateRepo` behavior unchanged (existing pipeline tests still pass)
- [x] 1.2 Add `resumeRepo(cfg, db, repo)`: lock → `readWipMeta` gate ("nothing to resume" result, no run) → pinned-target run without pull or skip; tests: runs at the pinned sha with the remote ahead and no pull invoked, executes when pinned sha equals `lastIndexedSha`, no-op result when no WIP, failed run restores the last good bundle, rate-limited run preserves WIP with attempts advanced
- [x] 1.3 Exhausted-attempts resume surfaces `planResume`'s refusal (run fails with the "needs attention" error, WIP cleared) — test via the existing producer shims

## 2. Admin endpoint

- [x] 2.1 `POST /api/repos/:id/resume` in `src/server/admin.ts`: 404 unknown repo, 409 lock held (probe), 409 no preserved build, else 202 + background run via `markRunStarted`/`recordRun`/`saveState` like `runUpdate`; tests: the four outcomes, run observable through `adminRuns`, outcome recorded from a 202

## 3. Dashboard

- [x] 3.1 Resume action in `src/server/dashboard.js`: button rendered only when the row's status entry has `build != null`, handler posts `/api/repos/:id/resume` and surfaces the response notice without blocking; tests: row with build renders Resume, row without build renders none, click issues the POST (pure helper/DOM-guard patterns used by the existing dashboard tests)

## 4. Validation

- [x] 4.1 `bun test ./src ./test` green; `bun run lint`; `bun run typecheck`; `openspec validate --specs`
- [x] 4.2 Every `#### Scenario:` in the three delta specs maps to a passing test named `<Requirement> › <Scenario>`
