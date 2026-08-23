## Context

The `claude` producer checkpoints pages but not planning: one session explores
the whole checkout and writes `.odw-plan.json` once, at the end (see proposal.md
— Why). The plan file is the run's checkpoint (`claudePlan.ts`), the WIP area
preserves it wholesale, and `run.ts` preserves on `rate_limited` or
`partial: true` — so the machinery to survive a dead planning session exists;
only the planning session produces nothing durable to preserve. openwiki (v0.4.3,
read from its dist) has the same planning hole but validates each unit on
arrival at a tool-call boundary; our equivalent boundary is the session exit.
The observed failure that motivated this change (a ~10k-file repo, since
removed) in fact died in the *pages* phase — its plan checkpoint worked; four
per-page session timeouts consumed the whole run budget. This change
deliberately scopes to planning; page-session cost is the recorded follow-up,
not silently assumed solved.
Constraint from the producer contract: only `run.ts` may branch on producer id;
claude-private modules carry the `claude` prefix; dot-files in the bundle are
invisible to everything downstream.

## Goals / Non-Goals

**Goals:**
- A planning unit lost is at most one session's spend, at every failure shape
  (rate limit, timeout, api_error).
- Progress legible from the same durable units, on the web only.
- Zero new stored state: artifacts are the units; counting is read-time.

**Non-Goals:**
- Split planning for update runs; progressive plan writes; plan-repair
  sessions; CLI progress; any polling/streaming/event emission.

## Decisions

**D1 — Checkpoint at the session exit, not inside the session.** The unit
boundary is the process exit because that is the only point we can enforce: a
`claude -p` session emits one JSON result at exit and nothing we own can
observe writes mid-flight. Progressive writes (asking the model to checkpoint
itself) were rejected for unverifiable compliance whose failure mode — silent
no-op — is exactly what this codebase designs against.
*Alternatives considered:* progressive plan writes — rejected, model-trusted and
needs a completion detector; in-session tool-call validation like openwiki —
rejected, impossible across a process boundary.

**D2 — Gate by tracked file count; new knob `ODW_CLAUDE_SPLIT_PLAN_FILES`
(default 2000, init-only); areas sized by the same count.** Split planning
costs extra sessions, so it must fire only where one planning session
plausibly exceeds a usage window — measured in the unit git gives us for free.
Serves the "Checkpointed planning for large initial bundles" requirement: the
threshold is its gate. Area size is derived, not a second constant: each area
covers at most min(5%·N, 100) files, and map validation rejects a map whose
area count sits outside half–double ceil(N / min(5%·N, 100)) — a lazy 3-area
map of a 10k repo and a runaway 500-area map both fail, ~100 passes. (At gate
2000 the 5% leg is inert — min is 100 for every N ≥ 2000 — kept so the formula
stays coherent if the gate ever drops.) The default is a first estimate,
calibrated at the rollout run below.
*Alternatives considered:* always split — rejected, 95 repos pay 2 sessions for
1; a fixed area-count cap — rejected, collides with derived sizing at every
repo above the gate; size the gate in bytes — rejected, file count is what
exploration cost tracks.

**D3 — Map and parts are dot-files in the bundle.** `.odw-map.json` =
`{targetSha, areas: [{id, title, scope}]}`; `.odw-plan.part-<id>.json` =
`{pages: PlanPage[]}` (the existing entry shape). Merge = concatenate parts,
feed the ordinary `normalizePlan`, stamp with `targetSha` via the existing
`stampPlan` — APPLY, pages, FINISH are untouched. The WIP area's wholesale
copies preserve and restore them for free, and dot-file invisibility already
holds. Drift check reuses the `appliedAtSha` semantics: a map/part stamped with
another commit is discarded. An empty part is valid — an area that turns out to
need no pages is done.
*Alternatives considered:* a separate checkpoint directory — rejected, breaks
the wholesale-copy invariant and adds staging code; one growing plan file —
rejected, concurrent-session-safe writes for no benefit.

**D4 — The digest is a claude-private pure module (`claudeDigest.ts`)** —
`git ls-files` with sizes, grouped per directory, size-capped — written to the
run's prompt-staging tmpdir and named in the map session's prompt. It is an
input, not an artifact: it never enters the bundle.
*Alternatives considered:* inline in argv — rejected, argv length limits; let
the mapper explore unaided — rejected, that exploration is the cost being cut.

**D5 — Area sessions reuse the planner contract.** Same `SKILL.md` +
`PLANNER.md` system prompt, plus per-area directives (area id, scope, `PLAN_FILE:`
part path, siblings to not plan) — mirroring `pageDirectives`. The map session
gets `MAP_FILE:` the same way. New guidance text lives in the versioned skill,
not in code.
*Alternatives considered:* a third phase file — rejected, PLANNER.md already
carries the exploration contract; AREA.md would duplicate it.

**D6 — Preserve-on-usable-plan is a `partial: true` on the existing run
report.** In the planning-failure path, `loadPlan` decides: a usable
unapplied/resumable plan finishes the run with `partial: true` (outcome
unchanged), which fires run.ts's existing preserve branch unchanged. No
contract change.
*Alternatives considered:* a new `ProducerRun` flag for "planning preserved" —
rejected, `partial` already means exactly "left resumable work".

**D7 — The progress reader is claude-informed, producer-blind in shape, and
lives beside the plan mechanics (`readPlanProgress` in `claudePlan.ts`).**
Input: staged bundle dir + WIP dir + whether a run is in flight (from registry
state — the artifacts alone cannot distinguish idle from undecomposed); output:
`{phase, split, done, total, lastUnitAt} | null`. In-flight planning with no
map and no plan yields `{phase: "planning", split: false}` — the undecomposed
marker; `null` is reserved for nothing legible. The first minutes of a split
run (map not yet written) also show the marker; it self-corrects when the map
lands — accepted. `status.ts` calls it where `buildProgress` already imports
`wip.ts` — same precedent, no selection branching, so `contract.test.ts` stays
green. It prefers the staged bundle and falls back to the WIP area; every read
is best-effort (null on error).
*Alternatives considered:* reading plan/parts directly in `status.ts` —
rejected, leaks claude-private file names into the producer-agnostic layer;
emitting progress events — rejected, new state.

**D8 — Dashboard: one pure helper + one column, no polling.** `fmtProgress`
renders `planning 3/8 · 4m ago`; an undecomposed entry renders
`below threshold`; null renders as today. Reload stays manual-only per the
existing "Manual refresh only" requirement — watching a run means pressing
Refresh, and this change does not reopen that decision.
*Alternatives considered:* a poll interval for in-flight runs — rejected, would
require amending a deliberate spec requirement this change has no mandate to
touch.

**D9 — The attempt counter resets on forward progress, driven by a
producer-reported unit count.** `contract.ts` (producer-blind shared
vocabulary) gains `unitsCompleted` on the run report: the `claude` producer
counts validated maps, parts, merged plans, and produced pages from this run;
`openwiki` reports nothing and keeps today's counting. `run.ts`'s preserve
branch passes it to `saveWip`, which resets `attempts` when the run completed
at least one unit and increments otherwise. With hundreds of areas plus their pages,
no fixed attempt cap can converge — the cap's purpose ("stop retrying what
isn't progressing") is preserved exactly: only zero-progress runs advance
toward exhaustion, and a build with finitely many units always converges.
*Alternatives considered:* raise the default cap — rejected, moves the cliff
(3 → 10 windows still cannot fit hundreds of sessions); count windows instead of runs
— rejected, same cliff, new semantics.

## Risks / Trade-offs

- [Map quality gates the whole bundle] → sizing validation (each area within
  its file budget, count within the derived band), digest grounding, and
  unchanged acceptance gating; a bad map is discarded on drift and re-planned.
- [Near-duplicate pages at area boundaries] → the map owns scope boundaries and
  area prompts exclude siblings; merge dedupes identical paths only. Semantic
  dupes remain possible; acceptance's link/coverage checks bound the damage.
- [hundreds of units ⇒ a bundle several times the old ~22-page shape, credit with it] →
  accepted deliberately: bounded cheap units are the point; the rollout run
  prices it before any other repo is moved.
- [A one-unit-per-night crawler never exhausts] → the units are finite, so it
  converges; exhaustion still fires in three straight zero-progress runs for a
  genuinely stuck repo.
- [Total credit can rise (per-area bootstraps)] → the digest and map replace
  most bootstrapping; the point is bounded loss, not minimum spend.
- [Default threshold 2000 is an estimate] → knob is calibrated at the rollout
  run; too low costs extra sessions, too high leaves the bug in place — both
  visible in `repo list` and run notes.
- [Status polls stat one file per page] → bounded by bundle size, manual
  refresh cadence, best-effort null on error.

## Migration Plan

No migration: new artifacts appear only inside WIP/bundles going forward, and
stray dot-files from a rollback build are invisible by construction. Rollback =
raise `ODW_CLAUDE_SPLIT_PLAN_FILES`; in-flight repos simply replan next run.

**Rollout / calibration:** re-add the ~10k-file repo with the `claude`
producer, with raised budgets for the run (`ODW_CLAUDE_STEP_TIMEOUT_SEC=1200`,
`ODW_CLAUDE_TIMEOUT_SEC=7200`); read areas, parts, page count, duration, and
credit off `repo list` and run notes before revisiting the threshold, the
sizing band, or the defaults.

## Open Questions

(none — the threshold's final value is calibration, not design)
