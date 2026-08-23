# Design: add-producer-run-events

## Context

See proposal.md — Why. The event log currently records only `run_started` + one terminal event per run; the monitoring spec forbids recording the producer at all. The `claude` producer is multi-session with observable unit completions (map, area part, plan merge, page) that already exist as code-level concepts (`unitsCompleted` in `src/producer/claude.ts`); `openwiki` is one child process with none. `runIsolatedProducer` (`src/producer/run.ts`) already receives `repoId`, and `appendEvent` (`src/monitor/events.ts`) is a plain JSONL append usable from any layer that holds a `Config`.

## Goals / Non-goals

- Goals: producer attribution on lifecycle events; `producer_progress` events at the claude producer's unit completions; spec deltas keep the terminal sequence identical for both producers.
- Non-goals (design-level): no new config knobs, no buffering/batching of events, no event emission from the openwiki producer, no dashboard/status change (status progress already reads WIP artifacts at read time).

## Decisions

1. **Emit from `claude.ts` directly, attributed via `RunOptions.repoId`.**
   `runClaude` already holds `cfg`; give `RunOptions` an optional `repoId` and have `claude.ts` call `appendEvent` at each unit completion. `run.ts` passes `repoId` through (it already receives it). When `repoId` is absent (direct unit tests, `bun run eval`), no events are written.
   *Alternatives considered:* a progress callback threaded from the pipeline (a logging seam, rejected — adds an interface for one consumer); emitting from `run.ts` (rejected — stage boundaries exist only inside the producer).

2. **Stage enum fixed at `map` | `area` | `plan` | `page`, free-text `note`.**
   Stages mirror the existing unit vocabulary exactly, so `producer_progress` events and the `unitsCompleted` counter can never disagree. The note carries identity (area id, page path) and counts ("3/8 areas"). No `finalize` stage: the finalizer is deterministic, fast, and already covered by the terminal event.
   *Alternatives considered:* structured `done`/`total` fields per stage (rejected — `/status` progress is the computed view; events are the forensic trail, and free text suffices for `logs` reading).

3. **Producer on lifecycle events written at the existing `appendEvent` call sites in `pipeline.ts`.**
   `producerId` is already in scope at every lifecycle call site except `queue_enqueued` (scheduler — no producer selected, stays unchanged).
   *Alternatives considered:* deriving producer inside `events.ts` (rejected — `appendEvent` is a dumb append; selection knowledge stays in the pipeline layer).

4. **Failure of an event append must not fail a run.**
   `appendEvent` writes are already best-effort per call site conventions; progress emission reuses that. A forensic trail that can kill the run it is describing would invert its purpose.
   *Alternatives considered:* awaiting + propagating errors (rejected as above).

5. **`logs` filters before tailing; `--progress` opts in.**
   `readEvents` is given no line cap, `producer_progress` is dropped unless `--progress` is set, and the 200-line tail is applied after filtering — otherwise a mid-build repo's beats still push lifecycle events out of the tail. Reading the whole (rotation-bounded, ≤10MB) file in a CLI is acceptable.
   *Alternatives considered:* tailing 200 lines then filtering (rejected — the flooding problem survives); teaching `readEvents` a type filter (rejected — shared API growth for one consumer).

6. **The undecomposed planner also emits a `plan` beat.**
   Same stage, same note shape ("N pages" — the planner's count, before normalization adds the overview), emitted right after the unapplied plan validates. It is a progress beat only: the `unitsCompleted` counter is untouched, since undecomposed planning was never a resume unit and counting it would change resume semantics.
   *Alternatives considered:* leaving undecomposed runs without a `plan` beat (rejected — the review flagged the reader-facing inconsistency); counting it as a unit (rejected — behavior change to resume).

## Risks / Trade-offs

- [Log volume: a 145-area build emits ~150–300 lines per full pass] → existing 10MB rotation absorbs it; `logs --repo` filters. No new knob (a knob would need a consuming scenario).
- [Concurrent runs append interleaved lines] → already true today for lifecycle events; `repoId` on every progress line keeps per-repo tails coherent.
- [Progress events from a run that later fails can look like success in a naive tail] → terminal event always follows; the monitoring delta makes "progress never replaces the terminal event" a testable scenario.

## Migration Plan

Additive JSONL fields and one new event type; older lines simply lack `producer`. Readers (`logs`, tests) are type-lenient. Rollback = revert; no stored state changes.

## Open Questions

None.
