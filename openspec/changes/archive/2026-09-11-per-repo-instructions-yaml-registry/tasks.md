## 1. Registry: YAML + state split

- [x] 1.1 Add `yaml` dependency (allowed per AGENTS.md; serves the comment-preserving registry requirement)
- [x] 1.2 Rework `registry.ts`: load/save `registry.yaml` via `yaml` Document round-trip (comments preserved); registry type = human fields only (repoId, source, schedule, options, instructions)
- [x] 1.3 Add `state.ts`: `<dataDir>/state.json` (repoId-keyed clonePath, addedAt, lastRun, lastIndexedSha, lastSuccessAt), atomic tmp+rename writes
- [x] 1.4 One-time migration: `registry.json` → `registry.yaml` + `state.json` on load when yaml absent; legacy file left in place; clear errors on partial failure
- [x] 1.5 Update `removeRepo`/`removeRepoDir` paths: purge state entry alongside registration
- [x] 1.6 Tests: YAML round-trip, comment preservation after save, migration (fresh + legacy), orphan-state tolerance, remove purges state

## 2. Per-repo wiki instructions

- [x] 2.1 Pipeline seeding: before every openwiki init/update run (non-noWiki), write non-empty registry `instructions` to `<checkout>/openwiki/INSTRUCTIONS.md`; empty/absent → file untouched
- [x] 2.2 CLI: `repo add --instructions <file|->` (file or stdin), stored in the registry entry
- [x] 2.3 CLI: `repo instructions <repoId> [--show]` — print configured instructions or a clear "none configured" message; unknown repoId error
- [x] 2.4 CLI: `repo list` marks rows with custom instructions
- [x] 2.5 Amend AGENTS.md bundle invariant: `INSTRUCTIONS.md` seeding exception (input surface, not output)
- [x] 2.6 Tests: seeding before init/update (openwiki shim asserts file content), re-seed after agent rewrite, no-instructions leaves file untouched, `--instructions` file + stdin, instructions show/unknown-repo, list marker

## 3. Monitoring updates

- [x] 3.1 `health.ts` / `status.ts` / CLI `status` / `logs` switch lastRun/lastIndexedSha/lastSuccessAt reads to the state store
- [x] 3.2 Tests: classification + status summary built from state store; existing scenario tests updated

## 4. Source documentation (repo add flow)

- [x] 4.1 Concise intended-flow docblock on `runPipeline`/`addRepo` (register → clone → seed instructions → openwiki → verify → index → record); no prose duplication

## 5. Docs & validation

- [x] 5.1 README: YAML registry (editable, commented, `instructions:` block), new CLI flags, example `registry.yaml`
- [x] 5.2 Verify all scenarios from the delta specs pass; `openspec validate` for the change
