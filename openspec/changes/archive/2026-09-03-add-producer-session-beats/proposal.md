# Proposal: add-producer-session-beats

## Why

A `claude` run on a 16k-file repo failed after 9:51 with `"run failed with no further detail"` and zero events in between — the event log had nothing between `run_started` and `run_failed`, so a hung or silent session was invisible until the run died. Completion beats only tell you what finished; nothing says what *started*.

## What Changes

- New `producer_progress` stage `session`, emitted immediately before every `claude` child session spawns (map, area, planner, page, repair), with a note naming the job.
- New `producer_progress` stage `planning`, emitted once when a run that has no usable plan enters its planning phase, with mode and tracked-file count.
- The monitoring event-log requirement's stage vocabulary grows accordingly and its wording distinguishes start beats (`planning`, `session`) from completion beats (`map`, `area`, `plan`, `page`).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `monitoring`: the event-log requirement's `stage` vocabulary and beat semantics.

## Impact

- `src/monitor/events.ts` (stage union), `src/producer/claude.ts` (two emission points: the `session()` closure covers every spawn; the plan-needed block covers planning start).
- Log volume: one extra line per session. The `logs` default filter already hides beats; `--progress` shows them.
- Completion beats and their ordering are unchanged.

## Non-goals

- No beat for the cheap `claude --help` probes (no session, no model cost).
- No beats from the `openwiki` producer (single child process — `run_started` already announces it).
