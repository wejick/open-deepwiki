## 1. Mode derivation in the update flow

- [x] 1.1 In `updateRepo` (src/repoManager/pipeline.ts), derive the mode from bundle-directory presence and omit `changedSourcePaths` in the init case. Verify with bun:test against a fixture repo whose initial run failed before publishing: the run executes as an init — the producer prompt does not claim a bundle exists and init-coverage acceptance applies ("Update on a repo with no published bundle runs as init"); a fixture with a published bundle keeps update semantics exactly as before ("Update on a repo with a published bundle keeps update semantics").
- [x] 1.2 Gate the no-op skip check on the same presence test. Verify with bun:test: a repo at its last indexed sha but with no published bundle is not skipped and runs as an init ("A repo whose bundle is gone is rebuilt despite an unchanged head").
- [x] 1.3 Incident regression: beyond-threshold fixture repo, failed first run (map rejected by the shim), then `updateRepo` — verify the recovery run decomposes planning (map session runs before any area session) with init acceptance ("A failed first build recovered by the batch is an init").

## 2. Validation

- [x] 2.1 Run `bun test ./src ./test`, `bun run lint`, `bun run typecheck`, and `openspec validate --specs`; confirm every scenario name in the delta spec appears as a test name.
- [x] 1.4 Carve the skip back out for `--no-wiki` repos: their bundle is absent by configuration, not by loss, so a no-wiki repo at its last indexed sha keeps the no-op skip (the scheduler dispatches no-wiki repos through `updateRepo` too). Verify with bun:test: a no-wiki repo at its indexed sha is skipped, and a moved head still pulls and re-indexes it ("A no-wiki repo at its indexed sha stays skipped").
