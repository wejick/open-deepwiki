# Tasks: clear-stale-error-on-run-start

## 1. Start marker (repo-manager delta)

- [x] 1.1 Add `markRunStarted(repo)` to `src/repoManager/pipeline.ts` beside
  `recordRun`: sets `lastRun.startedAt`, clears `finishedAt` and `error`, touches
  nothing else; test in `src/repoManager/repoManager.test.ts` — "Run observability ›
  Stale error cleared when a run starts": a record with a failed `lastRun` (error,
  finish time, outcome, last-success state) keeps outcome/duration/sha/last-success,
  and reports `startedAt` set, `finishedAt` null, `error` null
- [x] 1.2 Replace every hand-set `lastRun.startedAt` with the marker — `add.ts`
  `runAddPipeline`, `admin.ts` `runUpdate`/`runReinit`, `cli/main.ts` batch add,
  `updateOne`, `reinitOne` — no behavior change beyond the cleared error/finish

## 2. Observable on the web (admin scope)

- [x] 2.1 Extend `src/server/admin.test.ts` ("Update repository endpoint") with the
  in-flight scenario: a repo whose recorded run failed (`error` set, red), a gated
  openwiki shim holding the run open, `POST /api/repos/repoA/update` → while the run
  is in flight `/status` reports `lastError: null` with `runStartedAt` set,
  `runFinishedAt` null and health still red; after the gate opens and the run
  settles, the outcome is recorded as success through the ordinary recorder

## 3. Validation

- [x] 3.1 Full gate: `bun test ./src ./test`, `bun run lint`, `bun run typecheck`,
  `openspec validate` (main specs + this change); every scenario in the delta spec
  maps to a passing test
