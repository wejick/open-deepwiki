# Design: split over-budget map areas

## Context

See proposal.md — Why. In the split-planned init path (`src/producer/claude.ts`),
a map the mapper wrote is normalized by `repairMap` and then judged by
`validateMap` (src/producer/claudePlan.ts:360). `validateMap` rejects any area
whose owned files exceed `areaFileBudget(N)` and the run dies with "the map was
rejected" — a hard stop, because the mapper cannot see the recursive subtree
totals the validator charges, so overflow is systematic:
one area = ~1.4k files vs a 684 budget). The digest defect is out of
scope here (proposal Non-goals); this change makes the coarse map *survive* by
splitting the oversized area deterministically before validation.

## Goals / Non-Goals

Goals:
- An over-budget area becomes a set of at-most-budget parts instead of a failed
  run, at both places a map is validated (a fresh map session's output and a
  restored, unvalidated map).
- Parts keep a recognizable link to their origin area (id prefix + `part-<k>`,
  same title/scope) so the area sessions planning them stay coherent.
- Deterministic: the same map + same tracked-file list yields the same parts,
  so resume and re-validation agree.

Non-Goals:
- No digest/subtree-total change (separate follow-up).
- No change to `validateMap`'s remaining rejections (off-count, unusable scope,
  duplicate id) or to the sizing formulas.
- No same-run map re-planning; `validateMap` stays the final arbiter.

## Decisions

### D1: The split is a pure function run before `validateMap`
New exported `splitOverBudgetAreas(map, trackedFiles): RepairedMap` in
`src/producer/claudePlan.ts`, alongside `repairMap`. Both map-validation sites
in `claude.ts` (restored unvalidated map ~line 624, fresh map ~line 662) become
`repairMap` → `splitOverBudgetAreas` → `validateMap`, with the split's repair
notes appended to the existing `map repaired:` note. A map with no over-budget
area passes through unchanged (no-op). `validateMap` keeps its over-budget
rejection as its own contract (its unit tests stay green); it simply no longer
fires because the split runs first.
Alternatives considered: folding the split into `validateMap` (rejected —
mutation hidden in a predicate, and `loadMap`/unit tests treat validate as pure);
teaching the map session to retry (rejected — same cost as today's failed run,
and it would fail again on the same blind digest).

### D2: Greedy directory-first partition, not exact bin-packing
An over-budget area's non-root owned files are reduced to *units* each at or
under the budget, then packed greedily in DFS order (children of a directory
ordered by descending owned count, ties by name) into consecutive parts — a new
part opens only when the next unit would overflow the current one. This yields
directory-contiguous slices (HomeScene stays with its scenes, not interleaved
with `hooks/`), determinism, and near-minimal part counts without an optimizer.
A directory that itself exceeds the budget is decomposed into its child
directories first, so the model's habit of claiming one whole stream is cut
along the repo's real sub-boundaries; files sitting directly in a directory are
grouped (and chunked at the budget if a flat directory holds more than budget
files directly) so every over-budget area has a split.
Alternatives considered: exact bin-packing (overkill — no optimality
requirement; first-fit on units is within ~1.7× optimal and the trailing part
only matters via the off-count ceiling, a rare reject we accept); pure
file-chunking on a sorted file list (rejected — would produce parts with no
directory coherence).

### D3: Parts inherit id prefix, title, and scope
Part `k` of area `auth-onboarding` is named `auth-onboarding-part-1`,
`-part-2`, … with the same `title` and `scope`. The shared prefix and identical
title are the "same family" signal the area/planning sessions see, per the
change request. The scope text is deliberately not rewritten.
Alternatives considered: fresh synthetic ids and scopes (rejected — hides the
origin area entirely); annotating scope with "part k of N" (rejected — rewrites
model-authored prose and buys nothing the id prefix does not already say).

### D4: Over-budget is measured exactly as `validateMap` measures it
The split triggers on the same `filesUnder(paths minus root scopes)` expression
`validateMap` uses (src/producer/claudePlan.ts:375), so splitting fires exactly
when validation would have rejected. Root (`"."`) scopes are exempt and never
split: they ride unchanged on part 1. Within an area, redundant paths that are
descendants of another claimed path are dropped before decomposition (they add
no ownership; the ancestor covers them), so the split partitions the area's
owned set exactly — no file gained, no file lost.

### D5: The parts replace the area in the map
The over-budget area is removed and its parts inserted in its place, so the
validated map owns exactly what the mapper drew (plus parts), and the area-count
rule then judges the true post-split count. If the split pushes the map over the
count ceiling, `validateMap` rejects it as an off-sizing map exactly as today —
rare, and a genuine signal that the mapper's map was structurally wrong.

### D6: Repairs surface through the existing note
Each split area appends `split <id> into N parts` to the `map repaired:` notes,
so operators see why the map they inspect has `-part-<k>` areas it never named.

## Risks / Trade-offs

- Mechanical parts are not flow-coherent (the digest still hides subtree
  totals, so coarse maps and their splits are the norm until the follow-up)
  → documented in proposal Non-goals; MAP.md keeps instructing the mapper to
  pre-split along flows precisely because the mechanical fallback is not a
  boundary the mapper designed.
- Part-count inflation pushes a map over the accepted area-count ceiling and it
  is still rejected/replanned → rare (models under-produce areas, splitting
  moves the count toward the sizing rule's expectation); the run note names the
  reason, so it reads as a genuine off-sizing rejection, not the old overflow
  wall.
- A generated `{id}-part-<k>` could collide with an area id the mapper chose →
  `validateMap`'s duplicate-id rejection fires and the map replans; negligible
  in practice, no special-casing.
- A flat directory holding more than budget files directly yields parts that
  list many file paths → chunked at the budget; pathological in real repos, and
  the only way to honor "every over-budget area has a split".

## Migration Plan

No persisted-format change: a split map is an ordinary `.odw-map.json` whose
areas happen to carry `-part-<k>` ids, so an in-flight WIP whose map is
re-validated next run flows through the split automatically, and a stamped map
that already validates is untouched. Deploy = ship the change; rollback = revert
the commit — a rejected map on the old build is no worse than today.

## Open Questions

None material: the digest follow-up and any area-coherence tuning are explicitly
separate and can be decided against measured results after this lands.
