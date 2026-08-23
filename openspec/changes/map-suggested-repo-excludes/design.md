## Context

The `claude` producer's init planning above `ODW_CLAUDE_SPLIT_PLAN_FILES` runs a
map session over a deterministic digest of the checkout's documentable files
(`src/producer/claudeDigest.ts`: git tracked files minus non-documentable
kinds). MAP.md's reach rule forces the mapper to give every digest group an
area, so tracked data payload — catalogs, golden fixtures, frame maps — gets
areas and pages. The digest never consults the exclude set: repo/global globs
already honored by `crawlSourcePaths` and `lexicalSearch`
(`src/index/crawl.ts`, `src/index/rg.ts`) do not reach the producer, so the
mapper is shown `dist/**` the index already ignores. The map JSON (`.odw-map.json`,
`AreaMap` in `claudePlan.ts`) is validated deterministically after its session
(`repairMap` → `splitOverBudgetAreas` → `validateMap` → `saveMap`) before the
area loop; a failed map clears planning artifacts and remaps. See proposal.md —
Why. Registry plumbing already exists: `effectiveExcludes(cfg, repo)`
(`src/repoManager/registry.ts`), the per-repo `excludeGlobs` field, and the
pipeline's index step builds `{ ...cfg, excludeGlobs: effectiveExcludes(cfg, repo) }`
(`src/repoManager/pipeline.ts`).

## Goals / Non-Goals

**Goals:**
- One extra artifact channel (the map's `exclude` list), one deterministic
  gate, no new model session.
- Auto-apply only where the gate proves no code/prose/config is lost; rejected
  proposals invalidate the map (no partial application, no coverage hole).
- Planning, index, and search agree on one merged exclude set per repo.
- The producer contract stays: `claude` writes only the bundle; the pipeline
  persists accepted globs.

**Non-Goals:**
- No human-review/suggestion channel, no vendored-code or mixed-tree
  exclusions, no file-pattern proposals (see proposal.md — Non-goals).
- No new config knob and no new dependency: the feature serves the 
  okf-producer *map exclusion gate* / *merged exclude set* and repo-manager
  *per-repo exclude globs* requirements; it reuses `globMatch`, the kind
  classifier, and the registry merge path.

## Decisions

### D1 — The producer run receives the repo's merged exclude set in its Config
`runPipeline` already builds the merged-`excludeGlobs` Config for `indexRepo`
(`pipeline.ts:209`). Pass the same `{ ...cfg, excludeGlobs: effectiveExcludes(cfg, repo) }`
into `runIsolatedProducer` so `runClaude`'s documentable-set computation, gate
no-op math, and dedupe all see what indexing sees. Mirrors the established
pattern; no new parameter type.
**Alternatives considered**: a new `ProducerInput` field — duplicates the merge
for no reason; `runIsolatedProducer` already takes the full `Config`.

### D2 — Glob exclusions are filtered at the digest's source list
`listDocumentableFiles` and `buildDigestTree` (the two functions the map
path's `tracked` list and structure handout both derive from) gain an optional
`excludeGlobs` argument that drops matched files and counts them in the
digest's exclusion report. Filtering at the source keeps the map validator's
`tracked` list, the handout, and area-slice rendering on one set — the
three-way agreement `relax-claude-map-ownership` already demands.
**Alternatives considered**: post-hoc filtering at render sites — the sizing
count (`tracked.length`, used for split threshold, budgets, expected area
count) and the handouts would drift apart again.

### D3 — The gate is a pure function beside `validateMap`, all-or-nothing
New `gateExcludeProposals` in `claudePlan.ts`: for each `{path, reason}`
proposal, derive from git (not the model's prose) whether (a) it names one
whole non-root directory with ≥1 currently-documentable tracked file (not
kind-excluded, not already glob-excluded — so it is not a no-op) and (b) no
tracked file under it is protection-worthy. "Protection-worthy" is three
deterministic lists next to the existing `MEDIA_EXT`/`LOCKFILES`/etc.:
code-file extensions, documentation extensions, and configuration filenames/
patterns (`package.json`, `tsconfig*`, `*config.*`, dotfiles). Any rejection
invalidates the whole map: clear planning artifacts, note the rejected path
and reason, remap — never partially apply, because the map covered nothing the
rejected proposal excluded.
**Alternatives considered**: apply the accepted proposals and force-coverage the
rejected tree — needs a re-run of the map anyway (the map never owned it) and
keeps two states where one suffices; accepting a no-op/glob-only proposal —
persists a dead rule.

### D4 — Accepted globs strip the map in the same run, before area sessions
When every proposal passes: narrow the digest tree + `tracked` list by the
accepted directory globs (`<dir>/**`), drop each area `path` that now owns no
documentable file and drop areas left owning none, then re-run the existing
`repairMap`/`splitOverBudgetAreas`/`validateMap` against the narrowed count and
`saveMap`. The area loop then renders slices from the narrowed tree. The saved
map keeps its `exclude` proposals so a resumed run re-gates identically (the
gate is a pure function of the checkout and proposals).
**Alternatives considered**: remap after applying globs — a whole extra map
session to achieve what pruning does deterministically.

### D5 — The producer reports applied globs; the pipeline persists them
`ProducerRun` gains `excludeGlobsApplied?: string[]`, set only by `claude` on
an init split run whose gate accepted proposals and whose run completed. The
producer contract is otherwise untouched (openwiki never sets it; acceptance is
producer-blind). In `runPipeline`, after `wikiRun.ok` and the continuity write,
and before `indexRepo`, call a new `appendRepoExcludeGlobs(repoId, globs)` in
`registry.ts`: reload `registry.yaml`, append the globs (normalized/deduped,
order preserved) to that repo's `excludeGlobs` only, atomic tmp+rename write —
a concurrent human edit survives because the write reloads rather than using a
stale in-memory copy. The index step's merged-excludes Config is recomputed to
include the applied globs so the same run's crawl/purge honors them.
**Alternatives considered**: the producer writing `registry.yaml` itself —
breaks the producer contract; persisting before acceptance/continuity — a
failed or rate-limited run would narrow the repo for a bundle that never
shipped.

## Risks / Trade-offs

- [A model that over-proposes wastes a map session per rejection] → the gate's
  criteria are restated verbatim in MAP.md guidance with a "propose nothing if
  unsure" default; the remap note names the rejected path, so the next session
  sees why.
- [Digest/crawl denominators still diverge (git ls-files vs working-tree walk)]
  → by design; the glob set is now shared, which is the drift that mattered
  (`dist/**` reaching the mapper).
- [Two inits concurrently writing `registry.yaml`] → rare (init runs are
  add-driven, under per-repo locks); the append helper reload-merge-writes
  atomically, so the last writer only adds its own repo's globs.
- [Index step could run under stale excludes after the append] → the index
  Config is recomputed with the applied globs appended (D5), never read from
  the pre-run record.
- [Auto-applied globs shift acceptance denominators (coverage, churn)] → they
  only ever remove genuinely inert data, and floors are recorded over time
  exactly as manual glob edits already are.

## Migration Plan

None: the feature activates only on a `claude` init split run whose map
proposes exclusions; repos with no map (small inits, updates, `openwiki`) are
untouched. Rollback is removing the appended globs from `registry.yaml`; the
next run simply plans and indexes them again.

## Open Questions

None.
