## Context

The `claude` producer's split-planning path builds a digest from `git ls-files`
(`claudeDigest.ts`) that currently lists **every** tracked file grouped per
directory, and sizes areas from that same raw count N (see proposal.md — Why).
Three call sites must agree on what the map owns: the digest the mapper reads
(`repoDigest`), the budget/expected-count arithmetic (`areaFileBudget`,
`expectedAreaCount` via `mapDirectives`), and the validator's per-area file
accounting (`validateMap(map, tracked)`). Today all three take the raw tracked
list. The map's own ownership wording lives in `MAP.md` (injected for the map
phase) and in the runtime-generated `mapDirectives` block.

## Goals / Non-Goals

**Goals:**
- A single, deterministic notion of "documentable file" shared by the digest,
  the sizing count, and validation — so the mapper's budget matches what the
  validator enforces.
- Map-phase guidance that drops exclusivity and full-file coverage and refuses
  areas for excluded kinds.
- Keep every changed wording consistent (skill file, prompt directives, digest
  header).

**Non-Goals:**
- No engine reach-check (per-top-level-group "at least one owner" stays
  model-side).
- No per-repo/configurable exclusion lists.
- No change to planner or page phase guidance, or to the `openwiki` producer.

## Decisions

### 1. One exclusion predicate, consumed by every call site
Add `listDocumentableFiles(cwd)` in `claudeDigest.ts`: tracked files minus
those matching a deterministic `isNonDocumentable(path)` predicate. `repoDigest`
builds its groups from it, the init-planning branch in `claude.ts` calls it for
the split threshold, and the resulting list is passed both to `mapDirectives`
(for N) and `validateMap` (for per-area accounting). The validator therefore
never counts an omitted file — an area path that reaches a directory holding
excluded assets is charged only for the documentable files under it.

*Alternatives considered*: filter only inside `repoDigest` and keep validation
on the raw tree — rejected: the validator would over-budget areas that the
mapper sized from the digest, reproducing today's mismatch. A separate config
knob for exclusions — rejected: no requirement consumes per-repo lists.

### 2. The excluded kinds are one fixed rule
The predicate classifies a repo-relative path as non-documentable when any of
these hold:
- media/binary by extension: images, fonts, audio, video, archives, documents
  (`.png .jpg .jpeg .gif .webp .svg .ico .avif .heic .ttf .otf .woff .woff2
  .eot .mp3 .wav .aac .m4a .mp4 .mov .m4v .webm .zip .gz .tar .jar .pdf`);
- lockfiles by basename (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
  `bun.lock`, `bun.lockb`, `Podfile.lock`, `Gemfile.lock`, `Cargo.lock`,
  `go.sum`, `poetry.lock`, `composer.lock`);
- string/localization catalogs: `.strings`, `.stringsdict`, `.po`, `.pot`, or a
  file under a path segment named `strings` ending in `.json` or `.xml`;
- generated dependency trees: a path segment of `node_modules`, `Pods`,
  `DerivedData`, or `.gradle`;
- lottie animation bundles: `.lottie`, or `*.json` under consecutive path
  segments `assets/animations`.

Kinds are mutually exclusive and counted per file so the digest can report the
excluded totals. *Alternatives considered*: exclude whole directories the map
names — rejected, the map is not trusted input to its own filter; include
`build/`/`dist/` — rejected, legitimate source trees live there in some repos.

### 3. The digest reports what it excluded
`repoDigest` keeps its current per-directory grouping (count + bytes) over the
documentable list, but its header becomes e.g.
`Documentable files: 15932 (118 excluded: 60 media, 41 string catalogs, 10
lockfiles, 7 generated)` so the mapper knows the map must own only what the
digest lists and why the numbers do not match the checkout's file count. The
`(root)` group is unchanged except that it now lists only documentable root
files.

### 4. Prompt wording tracks the set
`mapDirectives` drops "tracked file tree" / "all N tracked files" in favor of
the documentable framing and points at the digest as the sole inventory. `MAP.md`
is edited per the delta spec's ownership-guidance requirement (overlap allowed;
digest-listed files only; flows over file-kinds; a pre-write budget + reach
check; no coverage claims in the summary).

## Risks / Trade-offs

- **Splitting threshold now counts documentable files** → a repo heavy in
  assets may fall below `ODW_CLAUDE_SPLIT_PLAN_FILES` and plan in one session.
  Consistent with the new sizing, but a behavior shift; noted in the change
  notes. Mitigation: the threshold comparison deliberately switches to the same
  N so "split when the map would be too big for one session" still holds.
- **A fixed exclusion rule will mis-classify some repo** (e.g. a checked-in
  `assets/` of generated code, or source named `*.po`) → the predicate is
  deliberately conservative and file-level, so a mis-classified file is merely
  absent from the map's universe, not deleted or unindexed; the reach guidance
  still asks the mapper to notice uncovered code groups.
- **Wording drift between skill file and runtime directives** → both now use
  the digest as the single inventory and "documentable" as the term; the map
  prompt tests assert both sources carry it.

## Migration Plan

No data migration. Land as one change; the digest filter only affects future
init plan runs. Rollback is a revert of the change — map artifacts from a
filtered digest are checkpoint dot-files rebuilt on the next run.
