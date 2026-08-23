# Design: add-producer-session-beats

## Context

See proposal.md — Why. Every `claude` child spawn already funnels through the one `session()` closure in `runClaude` (`src/producer/claude.ts`), and each session prompt begins with exactly one machine-readable directive line (`MAP_FILE:`, `AREA_ID:`, `PLAN_FILE:`, `PAGE_PATH:`) — the same contract the test shims parse. Planning necessarily begins in the single block that runs when no usable plan exists.

## Goals / Non-goals

- Goals: a start beat for planning and one per session spawn, emitted through the existing `progress()` helper (repoId-gated, append-failure-tolerant, awaited for ordering).
- Non-goals: no beats for `claude --help` probes; no openwiki beats; no new fields beyond the existing `stage`/`note`.

## Decisions

1. **One hook in `session()`, job derived from the prompt's directive line.**
   `session()` becomes async, awaits `progress("session", job)` before `runSession`, where `job` maps `MAP_FILE`→`map`, `AREA_ID: x`→`area x`, `PLAN_FILE`→`plan`, `PAGE_PATH: p`→`page p`, and no directive (the repair prompt) → `repair`. The directive line is already the load-bearing machine contract of every prompt, so parsing it is deterministic, not heuristic.
   *Alternatives considered:* passing an explicit label argument (touches every call site for information the prompt already carries); emitting from `runSession` (a layer with no repo attribution).

2. **`planning` beat at the top of the plan-needed block.**
   The block entered when the plan is absent/stale/invalid is exactly "this run will plan"; the beat fires before the split decision, with note `"<mode>[, N tracked files]"` (tracked is only computed on init). Resumed runs with a usable plan skip the block and emit nothing.
   *Alternatives considered:* a beat per planning sub-phase (rejected — the `session` beats already name each).

## Risks / Trade-offs

- [Directive-line parsing breaks if a future prompt drops the directive] → the shims parse the same lines, so tests fail first; the fallback label is `repair`, never silence.
- [Volume: one extra line per session] → bounded by session count; `logs` hides beats by default.

## Migration Plan

Additive stage values; older log lines simply lack them. Rollback = revert.

## Open Questions

None.
