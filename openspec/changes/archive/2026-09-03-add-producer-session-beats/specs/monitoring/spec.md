# monitoring spec delta

## MODIFIED Requirements

### Requirement: Append-only event log
The system SHALL append structured events (JSONL: `run_started`, `run_succeeded`, `run_failed`, `run_rate_limited`, `queue_enqueued`, `producer_progress`) to `<dataDir>/events.jsonl` from indexing and scheduler runs, rotating the file (truncate to zero) when it exceeds a configurable size (default 10MB). The event log SHALL be the debugging forensic trail and SHALL NOT gate any runtime behavior.

An event SHALL carry `ts`, `type` and `repoId`, and where the event has them: `durationMs`, `error`, `producer`, and — for `run_rate_limited` — the `resetAt` the producer reported. The run lifecycle events (`run_started`, `run_succeeded`, `run_failed`, `run_rate_limited`) SHALL carry the `producer` selected for the run; `queue_enqueued` SHALL NOT carry a producer, since none is selected at enqueue time.

A `producer_progress` event SHALL carry the `repoId`, the `producer`, a machine-readable `stage`, and a short human-readable `note`. Start beats: `planning` — emitted once when a run with no usable plan enters its planning phase, the note carrying the mode and tracked-file count; `session` — emitted immediately before every child session spawns (map, area, planner, page, repair), the note naming that job, so a hung session is visible as the last spawned. Completion beats: `map`, `area`, and `plan` for the decomposed planning path (with `plan` also emitted when an undecomposed planning session's plan is validated) and `page` for every planned page — each naming the unit just completed. Progress events are never emitted in place of a terminal lifecycle event, and only by producers with observable internal stages; a producer that runs as a single child process emits none.

**Not emitted:** the grounding score, and token usage. Those are answered from the registry via `status --json`, not from the event log; the log's own `tokens` field is declared but never populated.

#### Scenario: Failed run recorded
- **WHEN** a producer update for a repo exits non-zero
- **THEN** a `run_failed` event with the error summary is appended for that repo

#### Scenario: Rate limit recorded distinctly
- **WHEN** a run ends because the producer's usage limit is exhausted
- **THEN** a `run_rate_limited` event is appended and no `run_failed` event is written for that run

#### Scenario: Rotation on size
- **WHEN** `events.jsonl` exceeds the configured rotation size
- **THEN** it is truncated and new events continue from an empty file

#### Scenario: Lifecycle events name the producer
- **WHEN** a run under either producer starts and then ends, any way it ends
- **THEN** every run lifecycle event for that run carries the producer selected for the run

#### Scenario: Progress at unit completion
- **WHEN** the producer validates the map, completes an area part, merges the decomposed plan, validates an undecomposed plan, or produces a planned page
- **THEN** a `producer_progress` event carrying that stage and a note naming the unit is appended for that repo

#### Scenario: Every session spawn is announced before it runs
- **WHEN** the producer is about to spawn a child session — map, area, planner, page, or repair
- **THEN** a `session` beat naming that job is appended before the session starts, so a hung or silent session is the last thing the log shows

#### Scenario: Planning start is recorded
- **WHEN** a run has no usable plan and enters its planning phase
- **THEN** a `planning` beat with the mode and tracked-file count precedes the first session beat of that phase; a run resuming a usable plan emits none

#### Scenario: Progress never replaces the terminal event
- **WHEN** a run that emitted `producer_progress` events ends
- **THEN** exactly one terminal lifecycle event (`run_succeeded`, `run_failed`, or `run_rate_limited`) is still appended for that run
