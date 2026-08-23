# Monitoring Specification

## Purpose

TBD — synced from change init-open-deepwiki (archived 2026-08-23).

## Requirements

### Requirement: Health and status endpoints
The system SHALL expose `GET /healthz` (no token; minimal liveness payload: ok flag, uptime, repo count) and `GET /status` (bearer-token-protected by the same middleware as MCP) returning JSON with: scheduler state (next run, last tick, queue pending/in-flight/max-parallel, locks held) and per-repo status entries (repoId, health, last success time, last indexed sha, document count, link health, last error, last run duration, token usage when recorded, and the last run's start and finish times so in-flight runs are observable), plus aggregate counts.

For a repo whose last run has a start time and no finish time, the status entry SHALL additionally carry a run-state classification computed at read time from the per-repo lock's recorded holder pid: `running` when the lock is held by a live process, and `interrupted` only on positive evidence of death — a lock whose recorded holder pid is no longer alive. Absent or unreadable lock evidence SHALL classify as `running`, because a run legitimately passes through windows where it holds no lock (between the run's start record and lock acquisition, and between lock release and outcome record). The classification SHALL NOT alter the health color, which stays derived from run outcomes and staleness alone; the underlying start/finish times SHALL keep being reported unchanged.

#### Scenario: Liveness check without token
- **WHEN** a monitoring probe calls `/healthz`
- **THEN** it receives 200 with a minimal ok payload and no repo details

#### Scenario: Full status with token
- **WHEN** an authenticated client calls `/status`
- **THEN** the response includes scheduler/queue state and one entry per registered repo with its last success, error, and cost fields

#### Scenario: Status requires token
- **WHEN** `/status` is called without a valid bearer token on a non-localhost bind
- **THEN** the server responds 401

#### Scenario: In-flight run visible in status
- **WHEN** a repo's run has started but not finished (run start time set, finish time null)
- **THEN** `/status` reports that repo entry with its run start time and a null run finish time

#### Scenario: Run with a live lock holder reads running
- **WHEN** a repo's run has started but not finished and its lock file records a holder pid that is alive
- **THEN** the entry's run-state classification is `running`

#### Scenario: Orphaned run reads interrupted
- **WHEN** a repo's run has started but not finished because its process died mid-run, leaving a lock whose recorded holder pid is dead
- **THEN** the entry's run-state classification is `interrupted`, and its health color is unchanged from what run outcomes and staleness alone produce

#### Scenario: No lock evidence keeps the running classification
- **WHEN** a repo's run has started but not finished and no lock file exists (the run is between its start record and lock acquisition, or between lock release and outcome record)
- **THEN** the entry's run-state classification is `running`, not `interrupted`

#### Scenario: Interrupted classification is not persisted
- **WHEN** `/status` classifies a repo's run as `interrupted`
- **THEN** the stored run state is untouched, and the next completed run's outcome overwrites the display through the ordinary outcome recorder

### Requirement: Deterministic repo health classification
The system SHALL compute per-repo health as one of three states: **red** when the last run failed — which includes a build that exhausted its resume attempts, since that is reported as a failed run; **yellow** when the last run was `rate_limited`, when the repo's grounding score is below a *configured* floor (a floor of 0 means measure-only and SHALL NOT colour the repo), or when `now − last_success > 2× expected update interval` (from the repo's schedule); **green** otherwise, including a repo that has never run. The classification SHALL be derived at read time from registry state, not stored.

A build in progress SHALL be surfaced separately from health: the status entry SHALL carry the pinned commit and attempts consumed, read from the work-in-progress metadata, so an operator can tell a multi-night build from a stalled repo.

**Not implemented:** a distinct **blue** (building) health state, and any suppression of the staleness rule for a repo that is mid-build. A first build spanning several nights has no `last_success` yet, so it reads green; a *re*build spanning several nights keeps its old `last_success` and therefore reads yellow on staleness while it is in fact making progress. The build field is what distinguishes the two today.

#### Scenario: Failed run marks repo red
- **WHEN** a repo's most recent producer run failed
- **THEN** `/status` and CLI `status` report it as red with the error message

#### Scenario: Stale repo marked yellow
- **WHEN** a repo on the nightly schedule has had no successful update for more than two days
- **THEN** it is reported yellow

#### Scenario: Rate-limited repo marked yellow, not red
- **WHEN** a repo's most recent run ended as `rate_limited`
- **THEN** it is reported yellow with the limit as the reason, and not counted as a failure

#### Scenario: In-progress build is visible alongside health
- **WHEN** a repo's build has spanned several nights while pinned to a target commit, with attempts remaining
- **THEN** the status entry reports the pinned commit and attempts used, so the repo can be told apart from a stalled one; its health colour is still computed from run outcomes and staleness alone

#### Scenario: Exhausted build marked red
- **WHEN** a repo's build consumes its maximum resume attempts without completing
- **THEN** that run is reported as failed, so the repo reads red; the work in progress is discarded, and the next batch starts a fresh build rather than resuming

#### Scenario: Ungrounded wiki marked yellow
- **WHEN** a repo's recorded grounding score is below the configured floor because cited files were deleted upstream
- **THEN** it is reported yellow so the decayed pages are visible without a failed run

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

### Requirement: server_status MCP tool
The server SHALL expose a `server_status` MCP tool returning the same summary as `/status` (scheduler/queue state, aggregate health counts, per-repo health with last error), so clients can ask conversational health questions ("why is repo X stale?") without knowing the URL.

#### Scenario: Health question via MCP
- **WHEN** a client calls `server_status`
- **THEN** the response contains queue state and per-repo health classifications with red repos including their last error

### Requirement: Production progress in status
`/status` SHALL carry a per-repo production-progress field so an operator can
see where an in-flight or preserved build stands. Progress SHALL be computed at
read time from durable production artifacts — never stored — by counting the
validated plan's units against the staged bundle: during planning of a
decomposed build, phase `planning` with the map's areas as the total and
present valid parts as done; during page generation, phase `pages` with the
validated plan's pages as the total and present conformant pages as done. Each
entry SHALL carry the time of the newest contributing artifact as the last
progress beat, and whether the build's planning is decomposed. When a run is
not in flight, the same read SHALL fall back to the work-in-progress area, so a
multi-night build stays legible between runs. A build whose planning is a
single undecomposed session and is in flight SHALL report the planning phase
with an explicit undecomposed marker and no unit counts — distinct from null.
The field SHALL be null only when no legible artifact exists, such as an idle
repo. A read racing the producer's writes SHALL yield null rather than an
error. Progress SHALL NOT change health classification.

#### Scenario: Decomposed planning reports area progress
- **WHEN** a split-planning build is in flight with 3 of 8 area parts present and valid
- **THEN** `/status` reports that repo's progress as phase `planning`, 3 of 8 units, with the newest part's time as the last beat

#### Scenario: Page generation reports page progress
- **WHEN** generation is in flight against a validated plan of 22 pages with 12 present and conformant
- **THEN** `/status` reports that repo's progress as phase `pages`, 12 of 22 units

#### Scenario: Undecomposed planning is labeled, not blank
- **WHEN** a build's planning is one undecomposed session that is in flight and has not yet written a plan
- **THEN** that repo's progress reports the planning phase with the undecomposed marker and no unit counts, rather than a null field

#### Scenario: A preserved partial build stays legible between runs
- **WHEN** a build's planning artifacts and pages were preserved in the work-in-progress area and no run is currently in flight
- **THEN** `/status` reports progress from the preserved artifacts

#### Scenario: A racing read degrades to null
- **WHEN** the status read encounters an artifact mid-write or unreadable
- **THEN** progress for that repo is null and the status request succeeds

#### Scenario: Progress never changes health
- **WHEN** a repo reports planning or page progress
- **THEN** its health colour is still computed from run outcomes and staleness alone
