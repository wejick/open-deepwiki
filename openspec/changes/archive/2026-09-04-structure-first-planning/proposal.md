## Why

Planning sessions rediscover the repository's structure themselves, one Glob at a
time, even where a deterministic tree already exists. Measured on one real init
(~13.7k documentable files): the map session fired 11 Globs despite being handed
the full digest and told not to re-derive it; the area planning sessions fired
hundreds of Globs + dozens of Greps and Reads, most Globs enumerating subtrees `git ls-files`
already knows. Every Glob and orientation read is a model round-trip on a growing
context — pure cost on the planning phase, and it is exactly what a cheap,
deterministic structure handout should make unnecessary.

## What Changes

- **The digest names files, not just directories.** Each directory line gains its
  load-bearing files (largest-first, bounded) plus its size and count, so a
  session can tell which file speaks for a directory without reading the
  directory listing or probing candidates.
- **Every init planning session is seeded with the structure, scoped to what it
  plans.** The map session keeps the whole digest; each area session gains a
  digest slice covering its own owned paths (today it gets only path names and
  the mapper's prose); the undecomposed planner on an init gains the digest too
  (today it gets nothing below the split threshold).
- **Planning sessions no longer enumerate.** `Glob` is removed from the tool
  allowlist for the planning phases on init — map, area, and undecomposed
  planner. The handout is the enumeration channel; `Read`/`Grep` probe semantics
  "when needed". The rule is enforced by the toolset, not by prose, because the
  measured map session ignored prose.
- Update planning and page sessions are untouched: updates are change-scoped with
  `changedPaths` already handed over, and page sessions author one page from
  `sourcePaths`, where enumeration is legitimate.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `okf-producer`: the planning guidance's exploration model changes from
  "discover structure, then explore" to "structure is given, read to
  understand"; the digest requirement names files and extends seeding to every
  init planning session; planning sessions on init spawn without `Glob`.

## Impact

- `src/producer/claudeDigest.ts` (richer, sliceable digest), `claudePlan.ts`
  (area-scope slice helper), `claude.ts` (per-phase directive + tool allowlist),
  `skill/skills/okf-wiki/{MAP,PLANNER}.md` (prose aligned to the handout model).
- Test fixtures for the digest and planner-prompt scenarios; no new config knobs.
- Acceptance, page production, update planning, resume/checkpoint semantics
  untouched.

## Non-goals

- Structure handouts for update planning (change-scoped, `changedPaths` already
  supplied; not the observed cost).
- Parallel area sessions or any other run-level sequencing change.
- Changing the per-area budget, the split threshold, or the number of planning
  sessions.
- Removing orientation reads entirely, or planning pages from structure alone —
  the tree is a scaffold, not the information architecture.
