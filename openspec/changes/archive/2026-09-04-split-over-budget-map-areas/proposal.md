## Why

An over-budget map area is a hard stop: the `claude` producer rejects the map,
clears its planning artifacts, and fails the whole run. Measured on a 13k-file repo
(~13.7k documentable files, budget 684) the map session wrote one area = an entire
feature subtree (~1.4k files) and the
run died in ~3 minutes having built nothing. Because the mapper sizes from a
digest that hides recursive subtree totals, any feature over ~5% of the repo is
systematically written as one oversized area, so this recurs run after run.

## What Changes

- The producer gains a **deterministic overflow split**: at map-validation time,
  an area whose scope covers more than the per-area maximum is split into parts
  before the map is validated, instead of the whole map being rejected and
  replanned.
- Each part is named `{area-id}-part-{k}` and **inherits the area's title and
  scope**, so the shared id prefix and identical title tell the area sessions
  that plan them that they document one original area.
- The split cuts down the owned scope tree to the files themselves, so any
  over-budget area has a split; the repository root's own files stay exempt and
  are never split.
- `MAP.md` guidance is updated: an over-budget area is no longer "discarded" —
  it is repaired mechanically into `part-<k>` siblings, so the mapper still
  pre-splits along flows to keep the parts boundaries it designed.
- `validateMap` keeps rejecting what genuinely cannot be a map (off-count,
  unusable scope); only the over-budget rejection is replaced by repair.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `okf-producer`:
  1. *Checkpointed planning for large initial bundles*: over-budget areas are
     split deterministically into `part-<k>` siblings at validation time rather
     than rejected; scenarios pin the split naming, the file-level descent, and
     the surviving rejection cases.
  2. *Claude producer map ownership guidance*: the pre-write budget check's
     rationale changes from "an over-budget area discards the whole map" to "an
     over-budget area is split mechanically by the run".

## Non-goals

- No change to the digest format or the mapper's view of subtree sizes — the
  digest defect that *causes* coarse maps stays; this change makes the coarse
  map survivable. A subtree-aware digest is a separate follow-up.
- No change to the sizing formulas (`min(5% of N, 1000)`, expected count,
  root exemption) or to `validateMap`'s role as the final arbiter.
- No re-run of the map session inside a failed run; an unsplittable/off-count
  map is still rejected and replanned on a later run as today.
- No change to the `openwiki` producer, area/page sessions, or the WIP/resume
  lifecycle beyond what parts inherit from their origin area.

## Impact

- Code: `src/producer/claudePlan.ts` (new `splitOverBudgetAreas` +
  partition helpers), `src/producer/claude.ts` (both map-validation call
  sites run the split before `validateMap`), `src/producer/skill/skills/okf-wiki/MAP.md`
  (budget-check rationale).
- Tests: `claudePlan.test.ts` (split unit tests),
  `claude.test.ts` (an over-budget map now validates and spawns part sessions),
  `producerPipeline.test.ts` (the failed-first-build test must trigger a
  rejection that still exists — off-count, not over-budget).
- Spec: `openspec/specs/okf-producer/spec.md`.
