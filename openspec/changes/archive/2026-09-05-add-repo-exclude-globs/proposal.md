## Why

Global exclude globs (`ODW_EXCLUDE_GLOBS`) apply to every repo, but index noise is repo-specific: one repo carries ~4,500 tracked snapshot/asset-catalog/test files another repo may not have, and the inverse — excluding `__tests__` globally — would hide content other repos legitimately need indexed. Repos need their own exclude exceptions without touching the shared knob.

## What Changes

- Registry gains an optional per-repo `excludeGlobs` list, settable at `repo add --exclude <glob>` (repeatable, comma-separated also accepted) and editable in `registry.yaml` thereafter.
- `POST /api/repos` accepts an optional `excludeGlobs` array of glob strings alongside `source`/`producer`, validated and persisted as the repo's per-repo globs, so the dashboard and any API client can add a repo with its exclusions in one call.
- The dashboard add form gains an optional excludes field (one glob per line) submitted with the add request.
- Effective excludes for a repo = global `ODW_EXCLUDE_GLOBS` merged **additively** with the repo's list. Repo globs can only narrow, never re-include something the global list excludes.
- Both consumers honor the merged list: source crawling (`isExcluded`) and ripgrep lexical search (`-g !…` args).
- A change to a repo's `excludeGlobs` takes effect on its next indexing run (initial add or scheduled/manual update); already-indexed chunks for now-excluded files are dropped on that run.
- `repo list` shows the per-repo globs when set.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `repo-manager`: new requirement — per-repo exclude globs stored in the registry, settable at registration (CLI and admin API) and editable in `registry.yaml` afterwards, reported by `repo list`.
- `knowledge-index`: `Raw source ingestion` and `Lexical search via ripgrep` — the honored exclude set becomes global globs plus the repo's registry globs.
- `admin-api`: `Add repository with pre-flight validation` — the request body gains an optional validated `excludeGlobs` array.
- `dashboard`: `Repo management actions` — the add form gains an optional excludes field submitted with the add request.

## Impact

- `src/repoManager/registry.ts` (RepoConfig field, parse/validate/save), `repo add` CLI flag, `repo list` output.
- `src/server/admin.ts` (`POST /api/repos` body), `src/server/dashboard.js` add form + an exported pure `parseExcludeGlobs` helper (unit-tested in Bun, per the dashboard's no-framework invariant).
- `src/index/crawl.ts` and `src/index/rg.ts` take the repo's merged glob list; `src/index/update.ts` passes it through.
- `.env.template` unchanged; `ODW_EXCLUDE_GLOBS` keeps its meaning as the global baseline.
- No breaking changes; repos without the field behave exactly as today.

## Non-goals

- Per-repo **include** globs (global `ODW_INCLUDE_GLOBS` stays shared).
- Subtracting from the global exclude list per repo (re-inclusion).
- Per-repo `maxFileSizeBytes`, binary sniffing, or other crawl knobs.
- Editing excludes after addition via UI/API — no instructions-style PUT endpoint; `registry.yaml` stays the edit path.
