## Why

A `claude` init map over a large repo must give every digest group an area
(MAP.md's reach rule) — including tracked trees that are really data: golden
fixtures, `*.xcassets` catalogs, sprite-frame maps. Their files are text and
documentable-by-kind, so the digest lists them, planning budget and wiki pages
go to content nobody consults, and the index keeps surfacing it. The kind rule
cannot see these, and the per-repo exclude rule does not feed planning at all.

## What Changes

- The map session proposes exclusions inline: the map JSON gains an `exclude`
  list, and the guidance makes exclusion the escape hatch from forced coverage
  of a tree judged inert. One session, one artifact.
- A deterministic gate auto-applies only **high-confidence** proposals — whole
  directory, no matched file is code/prose/config-like, at least one matched
  file is currently documentable (real planning effect), not already excluded —
  and silently discards everything else. No human-review path exists.
- An accepted glob narrows the run's planning scope immediately (documentable
  set, digest subsets, stripped map) so the map continues lean, and is
  persisted to the repo's `excludeGlobs` so index/search and future runs agree.
- Claude planning honors the merged exclude set (kinds + globs) for its
  documentable set, fixing today's drift where the mapper is shown `dist/**`
  the index already ignores.
- Scope: `claude` producer, init split-planning runs only (a map session only
  exists there). The persistence write is done by the pipeline, not the
  producer, keeping the producer contract (bundle only) intact.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `okf-producer`: requirement *Claude producer map ownership guidance* gains
  the exclusion escape hatch; new requirements *Claude producer planning
  honors the merged exclude set* and *Claude producer map exclusion gate*
  define the narrowed documentable set, the proposal certification, the
  stripped-map continuation, and the reported outcome.
- `repo-manager`: requirement *Per-repo exclude globs* gains automated
  extension by an accepted map run; requirement *Registry write discipline*
  gains that writer and its no-clobber merge rule.

## Impact

- `src/producer/claude.ts` (map directives + gate + strip flow), `claudePlan.ts`
  (map schema/validation), `claudeDigest.ts` (doc set filter), MAP.md.
- `src/producer/contract.ts` (`ProducerRun` reports applied globs),
  `src/producer/run.ts`, the pipeline + `src/repoManager/registry.ts`
  (effective-excludes merge at the producer call; persistence save path).
- Spec: delta files under `specs/okf-producer/` and `specs/repo-manager/`.
- Tests: `claude.test.ts`, `claudePlan.test.ts`, `claudeDigest.test.ts`,
  registry/write-discipline tests; shim-driven sessions assert the gate from
  argv, never live calls.

## Non-goals

- No human review or suggestion channel — only high-confidence auto-applies.
- No vendored/imported trees, code-like trees, mixed directories, or
  behavior-config trees: the map covers them.
- No file-pattern proposals — whole directories only; patterns stay a human
  tool in `registry.yaml`.
- Pure-inert trees the digest already hides (svg-only asset dirs) — they cost
  no planning, so they are invisible to the map and stay out of scope.
- The `openwiki` producer, update runs, and small inits (below the split
  threshold) are unaffected — they have no map session.
- No new globs-editing UI/API — `registry.yaml` stays the human edit path.
