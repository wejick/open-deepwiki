# monitoring spec delta

## MODIFIED Requirements

### Requirement: Append-only event log
The system SHALL append structured events (JSONL: `run_started`, `run_succeeded`, `run_failed`, `run_rate_limited`, `queue_enqueued`, `producer_progress`) to `<dataDir>/events.jsonl` from indexing and scheduler runs, rotating the file (truncate to zero) when it exceeds a configurable size (default 10MB). The event log SHALL be the debugging forensic trail and SHALL NOT gate any runtime behavior.

An event SHALL carry `ts`, `type` and `repoId`, and where the event has them: `durationMs`, `error`, `producer`, and — for `run_rate_limited` — the `resetAt` the producer reported. The run lifecycle events (`run_started`, `run_succeeded`, `run_failed`, `run_rate_limited`) SHALL carry the `producer` selected for the run; `queue_enqueued` SHALL NOT carry a producer, since none is selected at enqueue time.

A `producer_progress` event SHALL carry the `repoId`, the `producer`, a machine-readable `stage` naming the unit of work just completed (`map`, `area`, `plan`, `page`), and a short human-readable `note` such as an area id, a page path, or unit counts. It SHALL be appended when a producer completes such a unit mid-run — the `map`, `area`, and `plan` beats apply to the decomposed planning path, with `plan` also emitted when an undecomposed planning session's plan is validated; the `page` beat applies to every planned page — never in place of a terminal lifecycle event, and only by producers with observable internal stages; a producer that runs as a single child process emits none.

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

#### Scenario: Progress never replaces the terminal event
- **WHEN** a run that emitted `producer_progress` events ends
- **THEN** exactly one terminal lifecycle event (`run_succeeded`, `run_failed`, or `run_rate_limited`) is still appended for that run

### Requirement: CLI status and logs
The system SHALL provide `open-deepwiki status` printing a per-repo table (repoId, health, last success, sha, docs, link health, producer, grounding score, build progress for a pinned repo, last error), with `--failing` (red/yellow only), `--json` (machine-readable), and `--server <url>` (merge live scheduler/queue state from the running server's `/status` using the configured token; bare `status` falls back to the registry-only view). The system SHALL provide `open-deepwiki logs [--repo <repoId>] [--progress]` tailing the event log with line filtering. `producer_progress` beats SHALL be excluded by default — so a decomposed build's unit beats cannot push lifecycle events out of the tail — and included only when `--progress` is given.

#### Scenario: Status table from registry
- **WHEN** the user runs `open-deepwiki status`
- **THEN** every registered repo is listed with its computed health, last success time, producer, grounding score, and last error if any

#### Scenario: Live queue merge
- **WHEN** the user runs `open-deepwiki status --server http://host:7245` while a nightly batch is running
- **THEN** the output includes current queue pending/in-flight counts from the live server

#### Scenario: Filtered logs
- **WHEN** the user runs `open-deepwiki logs --repo myrepo`
- **THEN** only event lines for that repo are shown

#### Scenario: Progress beats hidden unless asked for
- **WHEN** the event log holds `producer_progress` beats between lifecycle events and the user runs `open-deepwiki logs`
- **THEN** the beats are not shown; with `--progress` they are shown, and lifecycle events remain visible either way

#### Scenario: Build progress is readable
- **WHEN** repos are mid-build across several nights
- **THEN** `status` shows each one's pinned commit and attempts used, distinguishing them from stale and failed repos

#### Scenario: Migration progress is readable
- **WHEN** some repos have been migrated to the `claude` producer and others have not
- **THEN** `status --json` distinguishes them by producer, so grounding and health can be compared per producer
