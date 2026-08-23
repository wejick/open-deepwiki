## Context

See `proposal.md` — Why. Measured anchors from a ~13.7k-documentable-file
repo: the ~380-page plan carries ~90 screen-named pages; area sessions spend
55–65% of their 71–122 s streaming their part (a fixed ~2.5–3.4 s per planned
page of composition, dominant over the ~25% exploration the digest already
minimized); ~380 page sessions ≈ 12.8 h of page production per init.

Existing machinery this composes with, all in `claudePlan.ts` / `claude.ts`:
`repairMap` (normalization/dedup before validation, sizing never touched),
`splitOverBudgetMapAreas` (deterministic splits at validation), the collision
fold at merge (`foldCrossCutting`, earliest-in-map-order survives, unions
source paths + related pages), and the ordinary plan validation that page
sessions consume. The eval command already reports conformance, grounding,
links, coverage.

## Goals / Non-Goals

**Goals:**

- One budget, enforced once, at plan level: init plans name at most
  `max(12, ceil(N/100))` pages.
- Sessions self-limit via guidance; a rule-based merge pass absorbs ordinary
  overshoot; only an irreducible plan fails the run.
- Plan granularity becomes a visible number in eval output.

**Non-Goals:**

- No change to update planning (change-set scoped, small counts).
- No new acceptance floor, no bundle rejection on granularity (eval measures).
- No change to the page budget's interaction with resume: repair runs at merge,
  merge re-runs deterministically, so an interrupted run's parts are unaffected.
- No new config knob — the ratio is a constant (guardrail: knobs need
  scenarios; none exists yet, same reasoning as `DIGEST_MAX_FILES_PER_DIR`).

## Decisions

**1. Budget = `max(12, ceil(N/100))`, one gate, at plan level.** A ratio scales
across repo sizes; the floor keeps tiny repos from absurd single-page plans;
per the proposal, ~137 pages here vs ~380 measured. Single-session plans
(below the split threshold) are budgeted identically — the budget is a property
of the plan, not of the planning shape. Alternative: a per-area page cap
(`pages ≤ area files / 100` per part). Rejected — it can hold every part under
budget while the union still overshoots, and it duplicates the merge-time gate.

**2. Guidance in the skill files + directives, phrased as subject-merging, not
arithmetic.** `PLANNER.md` and the area-directive prompt gain: size the plan
near one page per hundred documentable files in scope; pages document
subjects, not tree nodes; do not plan a page per screen/dialog/leaf sharing a
subject. No `ceil(files/100)` arithmetic is given to sessions — models argue
with numbers; the target plus anti-pattern is what changes behavior.
Alternative: teach sessions the exact budget. Rejected — invites
budget-shaped plans (pages merged to satisfy a count rather than a subject).

**3. Repair merges by (type, common source-path parent), greedy by group
size, in map order — mirroring `foldCrossCutting`'s survivor rules.** The
surviving entry keeps the earliest position, takes its title from the common
parent directory, and unions source paths and related pages; merges repeat
until within budget or no group of ≥2 same-type same-parent entries remains.
The parent directory is already an ownership seam the map validated, so merged
pages have one area's worth of subject matter, and the per-area bound means a
merged page can never exceed one area's scope. Deterministic tie-breaks
(sort groups by size desc, then map order) make repair re-runnable and
testable byte-for-byte. Alternative: send the over-budget plan back to the
sessions for re-planning. Rejected — a model retry per overshoot costs the
sessions we are trying to save, and the repair output needs no judgment: the
seams are already validated.

**4. Failure shape = ordinary plan failure, with numbers in the note.** After
repair, an over-budget plan fails the run (`failed`), the note naming budget,
post-repair count, and unmergeable areas; the existing plan-invalid path
deletes the plan, and the next run re-merges (parts are untouched, so the
re-merge is deterministic and reaches the same failure unless the parts change
— which is the point: the operator must re-plan or accept the ratio). A
one-shot repair retry (acceptance-failure style) would loop on the same
deterministic result; not attempted.

**5. Eval reports `pages per documentable file` from the plan file when
present.** `bun run eval --checkout <clone>` reads the bundle's
`.odw-plan.json` when it exists (dot-file, so present only on in-flight
builds) — for published bundles the report reads the plan recorded at
acceptance... falls back to counting the bundle's own wiki pages, which is the
post-fold, post-overview page count and close enough for a granularity trend.
Reported for both `--a` and `--b` in comparisons.

## Risks / Trade-offs

- **Merged pages go shallow.** A parent-merged page covers more files; its
  page session has the same budget to cover them. Mitigated by the per-area
  scope bound (one area's worth of subject) and watched via grounding density
  (`ODW_GROUNDING_MIN_DENSITY` exists for exactly this read) — if density drops
  on merged pages, the ratio moves, not the seam rules.
- **The ratio is a guess until measured.** 1/100 is anchored on one repo.
  Eval's new report is the calibration instrument; the constant is expected to
  move once a few repos report (same lifecycle as the map's 684→1000 budget).
- **Screen pages that deserved to exist get merged.** A screen with genuinely
  distinct subject matter lands in a parent page as a section. Acceptable:
  retrieval is chunk-level, and the page session still reads and cites the
  screen's files; browsing granularity is the only loss, and only for screens.
- **Deterministic titles can read mechanically** ("user-profile" from a
  directory). Titles from directory names follow the repo's own naming, and
  page sessions can prose the title's casing; not worth a model round-trip.

## Open Questions

- None blocking. The ratio constant starts at 100 and is expected to be
  recalibrated from eval data, which does not need a spec change (the spec
  pins the formula's shape, and the constant is in code like the digest caps).
