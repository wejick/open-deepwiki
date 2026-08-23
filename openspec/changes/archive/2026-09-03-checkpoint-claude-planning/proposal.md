## Why

The `claude` producer plans a whole repository in one session whose only durable
output is written once, at the end. On a large init that session can outlive the
usage window or the per-session timeout: the run dies with no plan, every credit
spent is lost, and each retry replans from scratch until resume attempts
exhaust. The operator sees nothing between "run started" and "run finished".

## What Changes

- **Checkpointed planning (init, large repos).** Above a configured tracked-file
  count, planning runs as one map session (seeded by a deterministic git-derived
  digest) plus one session per area, each area sized at most min(5% of tracked
  files, 100) — the map is validated against that sizing. Each session writes
  its own dot-file artifact; present and valid means done; later runs continue
  from what is on disk; all parts merge into the ordinary plan file and the run
  proceeds unchanged. Commit drift invalidates map and parts as it does a
  stamped plan.
- **Planning artifacts are resumable work; attempts count only stalled runs.**
  A planner that dies after writing a usable plan ends the run `partial`, so
  the WIP area preserves it. The resume counter resets whenever a run completes
  a unit (map, part, plan, page) — only zero-progress runs advance toward
  exhaustion, so a many-window build converges.
- **Production progress in `/status` and the dashboard.** A read-time count of
  the durable artifacts: planning (areas done/total) or pages (done/total) plus
  a last-beat timestamp. Dashboard-only rendering, manual refresh only;
  undecomposed planning renders "below threshold".

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `okf-producer`: split planning of large initial bundles (map → parts →
  merge, sized and validated, resumable); resumable production treats a usable
  unapplied plan as resumable work and resets the resume counter on forward
  progress.
- `monitoring`: `/status` gains a read-time per-repo progress field; null when
  idle, an undecomposed marker when in-flight planning is not split.
- `dashboard`: renders progress; `below threshold` for undecomposed planning.

## Impact

- `src/producer/` (`claudePlan.ts`, `claude.ts`, digest module, plus
  `contract.ts`/`wip.ts`/`run.ts` for the attempt reset),
  `src/config/config.ts` (one knob), `src/monitor/status.ts`,
  `src/server/dashboard.js`. Acceptance, indexing, MCP tools untouched.
- No breaking changes; `/status` gains one nullable field.

## Non-goals

- Progressive plan writes inside one session (unverifiable compliance).
- A plan-repair session (invalid parts are cheap to re-plan).
- Split planning for update runs; page-session cost fixes (the observed
  follow-up).
- CLI progress display, auto-polling/SSE, events-per-unit, or any new stored
  progress state.
