## 1. `reinitRepo` in the pipeline

- [x] 1.1 Add `reinitRepo(cfg, db, repo, opts)` to `src/repoManager/pipeline.ts`:
      acquire the per-repo lock (busy → the same skipped-result shape as
      `updateRepo`); pull the existing clone when present; remove the published
      bundle dir, the snapshot and pre-run snapshot dirs, and the WIP area
      (`clearWip`); then run the init pipeline and return its `PipelineResult`.
      Verify `producerPipeline.test.ts` and the suite still pass.
- [x] 1.2 Scenario *Re-initialization rebuilds a repo from its existing clone*:
      a test where a repo has a published bundle and snapshot, the bundle and
      snapshot are then removed (the failed-first-build shape), an untracked
      sentinel file sits in the clone, and the origin head moves — reinit pulls,
      publishes a fresh bundle, recreates the snapshot, leaves the sentinel in
      place (no re-clone), and the run records init semantics.
- [x] 1.3 Scenario *Re-initialization unblocks an exhausted work-in-progress
      build*: a test where an exhausted WIP makes `updateRepo` refuse (the
      abandoned message) and reinit then clears it and rebuilds successfully.
- [x] 1.4 Scenario *A failed re-initialization leaves nothing published*: a test
      where reinit's init run fails (a failing producer shim) — the published
      bundle and snapshot stay absent afterwards, and a later `updateRepo` with a
      healthy shim rebuilds the repo with init semantics.
- [x] 1.5 A failed pull costs nothing: with the remote gone, `reinitRepo`
      rejects and the published bundle and snapshot survive (the pull runs
      before any destructive clear).

## 2. CLI surface

- [x] 2.1 Wire `repo reinit <repoId>` into `src/cli/main.ts`: the `repoCommand`
      case (empty argument → usage error), a `reinitOne` runner that mirrors
      `updateOne` (started mark → `reinitRepo` → `recordRun` → `saveState` →
      output line), and the USAGE/header/hint strings naming `reinit`.
- [x] 2.2 Verify an end-to-end CLI test: `main(["repo", "reinit", id])` against a
      real fixture origin + producer shim exits 0, publishes a bundle, and the
      recorded `lastRun.outcome` is `success`.
- [x] 2.3 Scenario *Re-initialization refuses an unknown repo*: `repo reinit
      <unknown>` exits 1 with an error naming the repo and changes nothing.
- [x] 2.4 Update the existing "Bare repo command" tests' subcommand loops to
      include `reinit`, and verify the empty-arg/usage errors name `reinit`.

## 3. Admin API and dashboard surface

- [x] 3.1 Add `POST /api/repos/:id/reinit` to `src/server/admin.ts` mirroring the
      update route: 404 for an unknown repo, a lock probe returning 409 while a
      run is in flight, otherwise a background `runReinit` tracked in `adminRuns`
      and a 202. Verify in `admin.test.ts`: unknown repo → 404, overlapping →
      409 with no second run, and a real reinit run (fixture origin + shim)
      rebuilds the repo and records success through the ordinary recorder.
- [x] 3.2 Add the per-row Reinit button and a confirm-guarded `rowAction` branch
      in `src/server/dashboard.js` that issues only `POST
      /api/repos/:id/reinit`. Verify in `dashboard.test.ts`: the row-action list
      includes `reinit`, and the Reinit block sits after a `confirm(` and never
      issues an update request.

## 4. Consistency and validation

- [x] 4.1 Run `bun test ./src ./test`, `bun run lint`, `bun run format`, `bun run
      typecheck`, and `openspec validate --specs`; fix any failures and confirm
      the full suite is green.
