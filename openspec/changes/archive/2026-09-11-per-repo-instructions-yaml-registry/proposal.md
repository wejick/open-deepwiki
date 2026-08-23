## Why

openwiki already supports per-repo generation prompts (`<repo>/openwiki/INSTRUCTIONS.md` is read every run as the agent's wikiGoal), but our system exposes no way to set or see it, and our repo registry is machine-written JSON that buries the few fields humans edit under run-state noise and cannot hold comments. Operators need a readable, commentable per-repo config and a first-class way to steer wiki generation per repo.

## What Changes

- **Per-repo wiki instructions**: a `repo add --instructions <file|->` flag, a `repo instructions <repoId> [--show]` command, and a `repo list` indicator. Instructions live in the registry; before every openwiki run the pipeline writes them to `<checkout>/openwiki/INSTRUCTIONS.md` (openwiki's wikiGoal input — verified in v0.3.3 source).
- **YAML registry**: the registry moves to `<dataDir>/registry.yaml` with human-owned fields (`repoId`, `source`, `schedule`, `options`, `instructions`) and preserved comments; machine-written run state (`lastRun`, `lastIndexedSha`, `lastSuccessAt`, `clonePath`, `addedAt`) moves to a separate `<dataDir>/state.json`. Existing `registry.json` is migrated automatically on first load. **BREAKING** for any tooling that read `registry.json` directly.
- **Documentation**: concise intended-flow docs for `repo add` in the source (pipeline entry point), mirroring the README's user-level description.

## Capabilities

### New Capabilities
- `wiki-instructions`: per-repo custom wiki generation prompts — config, CLI surfaces, seeding into the openwiki input file before runs.

### Modified Capabilities
- `repo-manager`: registry format/location (YAML, human vs machine state split, JSON migration), run observability recorded to the state store, CLI `repo add`/`instructions`/`list` behavior.
- `monitoring`: health/status read from the state store instead of the registry file.

## Impact

- Code: `src/repoManager/registry.ts` (YAML + state split), new `src/repoManager/state.ts`, `src/repoManager/pipeline.ts` (instructions sync step, flow docs), `src/repoManager/scheduler.ts`, `src/cli/main.ts`, `src/monitor/status.ts`, `src/monitor/health.ts`.
- Dependency: `yaml` (already on the allowed list in AGENTS.md).
- Data: one-time `registry.json` → `registry.yaml` + `state.json` migration on load.
- Tests: registry round-trip + migration, comment preservation, instructions seeding (openwiki shim asserts INSTRUCTIONS.md content), CLI flags.
- AGENTS.md: amend the "bundle is read-only" invariant with the INSTRUCTIONS.md seeding exception (it is openwiki's input surface, not its output).

## Non-Goals

- No per-repo LLM model/key overrides (still one global OpenAI-compatible endpoint).
- No instructions UI beyond the CLI + hand-editable YAML.
- No YAML support for other artifacts (events.jsonl, config, snapshots stay as-is).
- No writing to other bundle files — only `INSTRUCTIONS.md` is seeded.
