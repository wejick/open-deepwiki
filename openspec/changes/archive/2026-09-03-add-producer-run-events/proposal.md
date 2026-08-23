# Proposal: add-producer-run-events

## Why

A `claude`-produced repo failed with the event row `"error": "openwiki timed out"` and nothing else — no producer, no stage, no progress. The operator had to reconstruct what happened from WIP artifacts and file mtimes. The event log is the debugging forensic trail, but for multi-session producer runs it currently records only the two lifecycle endpoints, and the spec explicitly forbids recording which producer ran.

## What Changes

- Run lifecycle events (`run_started`, `run_succeeded`, `run_failed`, `run_rate_limited`) carry the `producer` selected for the run. The monitoring spec's "not emitted: the producer" clause is amended accordingly.
- New event type `producer_progress`, emitted at the `claude` producer's unit completions (map validated, area part planned, plan merged or — undecomposed — plan validated, page produced), each with repo attribution, stage, and a short human-readable note. The `openwiki` producer is a single child process with no observable stages and emits none.
- `open-deepwiki logs` excludes `producer_progress` beats by default and shows them with `--progress`, so a decomposed build's unit beats cannot push lifecycle events out of the tail.
- The okf-producer "same run event sequence" requirement is amended: the lifecycle sequence (started → one terminal event) stays identical for every producer; `producer_progress` events may be interleaved between them and never replace a lifecycle event.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `monitoring`: the event-log requirement's enumerated types gain `producer_progress`; the field list gains `producer` for run events; the "Not emitted" clause drops the producer.
- `okf-producer`: the run-cycle requirement now distinguishes the lifecycle event sequence (identical for all producers) from optional interleaved progress events.

## Impact

- `src/monitor/events.ts` (Event union), `src/repoManager/pipeline.ts` (producer on lifecycle events), `src/producer/claude.ts` (progress emission), `src/producer/run.ts` (repoId threading if needed).
- `bun odw logs` needs no change — it tails JSONL lines; new type and field flow through.
- Log volume: a split-planning repo emits one line per area part and per produced page (a 145-area repo ≈ a few hundred lines per full build). Existing 10MB rotation absorbs this; `logs --repo` filters per repo.
- Dashboard/status are unchanged — progress display already reads WIP state, not events.

## Non-goals

- No grounding score or token usage in events — they stay registry-only (`status --json`).
- No per-session *failure* events — failures are summarized in the terminal `run_failed` error, which this change's failure notes already enrich.
- No `queue_enqueued` change — no producer is selected at enqueue time.
