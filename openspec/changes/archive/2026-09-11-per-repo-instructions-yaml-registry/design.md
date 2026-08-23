## Context

The registry (`<dataDir>/registry.json`) mixes human-owned config (source, schedule, options) with machine-churned run state (lastRun, shas, timestamps), is JSON (no comments), and is rewritten wholesale on every run — so hand edits are noise-prone and comments impossible. openwiki v0.3.3 natively supports per-repo generation prompts: `<repo>/openwiki/INSTRUCTIONS.md` is read on every run as the agent's wikiGoal (verified: `setup/credentials/steps.js` reads `readRepositoryWikiInstructions(repoRoot)`; the agent prompt injects `{WIKI_GOAL}`), and it wins over the global home instructions. We expose none of this today.

## Goals / Non-Goals

**Goals:**
- Human-readable, commentable, hand-editable registry (YAML) whose comments survive machine saves.
- Machine run state separated from human config.
- First-class per-repo wiki instructions: config in the registry, CLI to set/show, seeded into openwiki's input before every run.
- One-time transparent migration from the legacy JSON registry.
- Concise intended-flow documentation for `repo add` in the source.

**Non-Goals:**
- No per-repo LLM endpoint/model overrides.
- No instructions editor UI beyond CLI + hand-editable YAML.
- No deleting the legacy `registry.json` after migration.
- No touching bundle files other than `INSTRUCTIONS.md`.

## Decisions

### D1: YAML registry with comment-preserving saves
`<dataDir>/registry.yaml` holds only human fields: `repoId`, `source`, `schedule`, `options` (`noWiki`), `instructions` (literal block scalar). Saves mutate a parsed `yaml` `Document` (parse once, `setIn` for changes, `toString` on write) so comments/formatting survive. Machine state moves to `<dataDir>/state.json` (JSON, keyed by repoId, atomic tmp+rename), holding `clonePath`, `addedAt`, `lastRun`, `lastIndexedSha`, `lastSuccessAt`.
- *Alternatives considered*: single YAML with both (comments still clobbered by run writes); JSON + comments-adjacent `# notes` file (invented format); document AST manipulation of a combined file (works but couples human/machine write paths).

### D2: Instructions live in the registry; the bundle file is the runtime channel
`registry.yaml`'s `instructions` is the source of truth. Before every openwiki run (init AND update, non-noWiki repos only), the pipeline writes non-empty instructions to `<checkout>/openwiki/INSTRUCTIONS.md` (openwiki's wikiGoal input); empty/absent instructions leave that file untouched. Re-seeding every run makes user config win even after the agent edits the file. Bundle invariant amended: `INSTRUCTIONS.md` is an input surface we seed; all other bundle files stay read-only.
- *Alternatives considered*: sidecar file in dataDir (second source of truth, sync bookkeeping); per-run CLI message arg (ephemeral, not config); global home instructions only (not per-repo).

### D3: CLI surfaces
`repo add <source> --instructions <file|->` (stdin via `-`); `repo instructions <repoId> [--show]`; `repo list` marks rows with custom instructions (`(instructions)` suffix or column). Editing the prompt = hand-edit `registry.yaml` (the point of the YAML move) or re-run add-flag.

### D4: Migration
On registry load: if `registry.yaml` is absent and `registry.json` exists, migrate once — human fields into YAML, run fields into `state.json`, legacy JSON left in place. Failure at any step = clear error, nothing partially written.

### D5: repo add flow documentation
A concise docblock at the pipeline entry (`runPipeline` / `addRepo`) describing the intended order: register → clone → seed instructions → openwiki → verify → index → record run. No prose duplication elsewhere.

## Risks / Trade-offs

- [yaml comment preservation is not lossless in all edits] → `Document`-based mutation only; instruction edits via block scalar replacement; test asserts comment survival after save.
- [openwiki agent rewrites INSTRUCTIONS.md during runs] → re-seed before every run (spec'd); user config is authoritative.
- [Hand-edited YAML breaks parsing] → clear parse error naming the file and line; registry load fails fast, no auto-repair.
- [Orphan state entries after manual registry edits] → state keyed by repoId, ignored when no registry entry, cleaned on `repo remove`.
- [Concurrent writers of state.json (CLI + scheduler)] → same atomic tmp+rename discipline as today's registry.

## Migration Plan

Ship code → first load after upgrade migrates automatically → verify `registry.yaml` + `state.json` contents, legacy JSON untouched → rollback = delete the two new files and restore the old JSON (still on disk).

## Open Questions

None.
