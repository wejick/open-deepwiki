## Context

Excludes flow from `Config.excludeGlobs` (env `ODW_EXCLUDE_GLOBS`) into two consumers: `isExcluded`/`crawlSourcePaths` (`src/index/crawl.ts`) at index time and `lexicalSearch` (`src/index/rg.ts`, `-g !…` args) at query time. Both read the same global `Config` object; neither knows about repos. The registry (`src/repoManager/registry.ts`) already carries optional per-repo config (`producer`, `instructions`) on `RepoConfig`, with `producerFor(cfg, repo)` as the established resolution pattern. `indexRepo`/`diffNames` (`src/index/update.ts`) are called from `pipeline.ts`, which holds the `RepoRecord`; server tools resolve `repoId` through the registry before searching. See proposal.md for motivation, the delta specs for behavior.

## Goals / Non-Goals

- Goals: per-repo narrowing of what is indexed and searched; one merge point per consumer path; no new stored state; the per-repo globs settable at addition from every add path — CLI, admin API, dashboard form.
- Non-Goals: per-repo include globs; re-inclusion against global excludes; producer-side scoping (the producer contract is untouched); editing the field after addition via UI/API (no instructions-style PUT endpoint — `registry.yaml` stays the edit path).

## Decisions

### D1 — Merge by Config copy, not new parameters
Add `effectiveExcludes(cfg, repo)` next to `producerFor` in `registry.ts`, returning `[...cfg.excludeGlobs, ...(repo.excludeGlobs ?? [])]`. Call sites (`pipeline.ts` before `indexRepo`; server tool handlers before `lexicalSearch`) build `{ ...cfg, excludeGlobs: effectiveExcludes(cfg, repo) }`. `crawl.ts` and `rg.ts` stay unchanged — they already honor `cfg.excludeGlobs`.
**Alternatives considered**: threading a globs argument through `indexRepo`/`lexicalSearch`/`crawlSources` — wider signatures in four modules for the same effect.

### D2 — Registry field is optional `excludeGlobs?: string[]`
Parsed from `registry.yaml` with the existing yaml loader; `repo add --exclude <glob>` repeatable, comma-separated values split. Entries are non-empty strings, trimmed, deduplicated; order preserved.
**Alternatives considered**: a single string column with the same comma format — loses structure on round-trip; storing globs in `state.json` — wrong file, they are human config, and write discipline reserves `state.json` for run outcomes.

### D3 — Glob changes take effect at the next run via chunk purge, not stored state
At the start of `indexRepo`, delete the repo's `source` chunks whose stored path matches the merged exclude globs (reuse `globMatch` over the chunk paths already in the DB), then crawl/diff as today. Newly excluded files vanish without a re-crawl; no "globs used last run" field is added.
**Alternatives considered**: detecting glob changes by storing the last-used list per repo — new state for something derivable at run time; forcing a full re-index on any glob edit — wasteful and still needs change detection.

### D4 — `repo list` prints the globs inline
A row with `excludeGlobs` shows them (comma-joined); rows without show nothing, as with the producer annotation.
**Alternatives considered**: a separate `repo show` command — no scenario needs it.

### D5 — Every add path writes both registry files; edits stay registry.yaml-only
`repo add` and `POST /api/repos` are both registrations — they already write both files and keep doing so. Later tweaks are human config edits in `registry.yaml`, picked up at load. The API endpoint reuses the CLI's registration save; no separate write path.

### D6 — API field is an optional array of glob strings, validated before pre-flight
`POST /api/repos` gains `excludeGlobs?: string[]`: must be an array of non-empty strings (trimmed), else 400 with a clear error, registering nothing and starting no run — the same fail-before-work order the `producer` validation already follows. Absent, null, or empty array records no per-repo globs.
**Alternatives considered**: a single comma-separated string — the registry stores an array, so the API would trade structure for a parse rule duplicated between CLI and API.

### D7 — Dashboard excludes field is a textarea parsed by an exported pure helper
One glob per line matches gitignore-style editing ergonomics and scales past comma-counting. `parseExcludeGlobs(text: string): string[]` (split lines, trim, drop empties, dedupe preserving first occurrence) is exported from `dashboard.js` and unit-tested in Bun; DOM wiring stays behind the `document` guard per the dashboard's no-framework invariant. A blank field omits `excludeGlobs` from the posted body rather than sending an empty array — both are valid per the API, omission is what the CLI path also records.
**Alternatives considered**: a comma-separated text input — one long glob list becomes unreadable; parsing in the submit handler — untestable without a DOM.

## Risks / Trade-offs

- [Mini-matcher and rg glob semantics diverge on a pattern] → the shared globs are simple (`**/`, suffix, segment); tests assert the same fixture path set is excluded by both crawl and rg args.
- [Stale chunks if a repo is never updated after a glob edit] → documented: the purge rides the next run; initial adds crawl with globs already set, the main scenario.
- [Query-time registry load per tool call] → registry is already loaded in the server for repo scoping; the merge is an array concat.

## Migration Plan

None: the field is optional and absent-by-default; rollback is removing it from `registry.yaml`.

## Open Questions

None.
