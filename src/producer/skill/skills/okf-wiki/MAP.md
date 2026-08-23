---
name: okf-wiki
allowed-tools: Read Grep Glob Write Edit
---

# This session: map the repository into planning areas

You are **mapping**, not planning pages and not writing any page. Your only
output is one JSON area map; separate sessions then plan each area's pages
from the map, and see nothing you learned except what you put in it.

Read the repository digest named in this session's instructions first — it is
the complete tree of the repository's **documentable files**, grouped per
directory with file counts, sizes, and each directory's largest files named,
produced from git. Files it omits are
non-documentable: media and binary assets, lockfiles, string and localization
catalogs, generated dependency trees, and animation bundles. The digest states
how many files it excluded, and you may not claim an omitted file. The digest is
authoritative for what exists; you may read files only to understand what a
directory _is_ for mapping coherent boundaries — never to rediscover the tree,
which the digest already gives you.

## Areas

Divide the repository's documentable files into **planning areas**: coherent
ownership boundaries a single session can plan — a subsystem, a flow, a
runtime domain, a platform silo — never an arbitrary file-count split. The
instructions give you the area budget (maximum files per area) and the expected
area count; stay within both — the repo root's own files are the one exemption
and may exceed the budget as a single area.

Areas are scopes, not a partition:

- A file may belong to more than one area. Overlap is for exploration, not for
  page ownership: a shared component is explored from each context that uses
  it, which makes better areas — but its page belongs to one area. Nothing
  requires a file to sit in exactly one area, and no area exists to "win" a
  file from another.
- Cross-cutting subjects — state management, constants or configuration,
  utilities or helpers, navigation or routing, analytics or logging, error
  handling — are planned as at most one page in the whole bundle, owned by the
  area whose paths host that code. Record that ownership in the owning area's
  `scope` (for example, "owns state management for the whole app"), so the
  areas planning from your map see the claim; an area whose scope merely
  consumes such code plans no page of its own for it, and the merge drops any
  duplicate that slips through.
- Omitted (non-documentable) files need no area and must not get one — never
  name an area for an image set, a strings folder, or any other omitted
  subtree, and never write a `path` that reaches into one.
- Name an area for the flow, module or platform it documents — the transfer
  flow, the OTP input, the iOS build — never for a file-kind directory that
  only holds that feature's scrap parts. Do not peel a feature into
  `-constants`, `-utils`, `-hooks`, `-types` stubs; if a feature is too big
  for one area, cut it along flows or screens and let its support directories
  ride inside the area that uses them.

For each area:

- **`id`** — stable, lowercase, hyphen-separated (`producer-pipeline`); it
  names the area's plan file.
- **`title`** — human-readable.
- **`scope`** — what the area is and what belongs on its pages, in your words.
  The area's planning session starts from this; a thin scope makes it re-explore.
- **`paths`** — the repo-relative directories/files the area owns. A
  directory may carry a trailing slash (`src/producer/`); the digest's
  `(root)` group is claimed as `.`.

## Verify before you write

Reconcile the map against the digest before writing it, and fix what it fails:

1. **Reach** — walk the digest's top-level groups — every distinct first path
   segment it lists, plus the `(root)` group — and confirm every group's code
   is under at least one area's paths. Overlap is fine; an uncovered code group
   is not — the area sessions only ever see what you mapped, and a group no
   area owns is silently absent from the wiki.
2. **Budget** — total the digest's per-directory counts under each area's
   paths and split any area whose total exceeds the budget in this session's
   instructions. An area you leave over budget is not discarded: the run
   splits it into `-part-1`, `-part-2` siblings along directory boundaries,
   so split before you write to keep each part a boundary you designed.
   Overlap counts toward every area it touches — that is expected.
3. **Scope** — an area named for an omitted subtree, or one that exists only
   to hold `constants`/`utils`/`hooks`, is not a boundary; fold or rename it.

## Write the map

Write your map as JSON to the absolute path given as `MAP_FILE` in this
session's instructions, using the `Write` tool. It is the only channel the run
reads your map from — a session that does not write it has produced no map.

```json
{
  "areas": [
    {
      "id": "producer-pipeline",
      "title": "Producer pipeline",
      "scope": "How a checkout becomes a bundle: run wrapper, acceptance, repair.",
      "paths": ["src/producer/"]
    }
  ]
}
```

A map that is unparseable, names no areas, uses an unsafe `id`, exceeds the
area budget, or falls outside the expected area count is discarded and the map
session re-runs. Your closing summary states what the map contains — it does
not assert that the map covers the repository, which the run verifies from the
artifact, not the prose.
