## MODIFIED Requirements

### Requirement: Deterministic repo health classification
The system SHALL compute per-repo health as: **red** when the last run failed or when a build exhausted its resume attempts without completing, **blue** (building) when the repo has an in-progress build pinned to a target commit and attempts remain, **yellow** when the last run was `rate_limited`, when the repo's grounding score is below the configured floor, or when `now − last_success > 2× expected update interval` (from the repo's schedule), **green** otherwise. A building repo SHALL NOT be reported as stale on the strength of its pinned age alone, since it is making progress by design. The classification SHALL be derived at read time from registry state, not stored.

#### Scenario: Failed run marks repo red
- **WHEN** a repo's most recent producer run failed
- **THEN** `/status` and CLI `status` report it as red with the error message

#### Scenario: Stale repo marked yellow
- **WHEN** a repo on the nightly schedule has had no successful update for more than two days
- **THEN** it is reported yellow

#### Scenario: Rate-limited repo marked yellow, not red
- **WHEN** a repo's most recent run ended as `rate_limited`
- **THEN** it is reported yellow with the limit as the reason, and not counted as a failure

#### Scenario: In-progress build reads as building, not stale
- **WHEN** a repo's first build has spanned several nights while pinned to a target commit, with attempts remaining
- **THEN** it is reported as building with its pinned commit and attempts used, and is not reported as stale

#### Scenario: Exhausted build marked red
- **WHEN** a repo's build consumes its maximum resume attempts without completing
- **THEN** it is reported red as needing attention, and is not retried by the next batch

#### Scenario: Ungrounded wiki marked yellow
- **WHEN** a repo's recorded grounding score is below the configured floor because cited files were deleted upstream
- **THEN** it is reported yellow so the decayed pages are visible without a failed run

### Requirement: CLI status and logs
The system SHALL provide `open-deepwiki status` printing a per-repo table (repoId, health, last success, sha, docs, link health, producer, grounding score, build progress for a pinned repo, last error), with `--failing` (red/yellow only), `--json` (machine-readable), and `--server <url>` (merge live scheduler/queue state from the running server's `/status` using the configured token; bare `status` falls back to the registry-only view). The system SHALL provide `open-deepwiki logs [--repo <repoId>]` tailing the event log with line filtering.

#### Scenario: Status table from registry
- **WHEN** the user runs `open-deepwiki status`
- **THEN** every registered repo is listed with its computed health, last success time, producer, grounding score, and last error if any

#### Scenario: Live queue merge
- **WHEN** the user runs `open-deepwiki status --server http://host:7245` while a nightly batch is running
- **THEN** the output includes current queue pending/in-flight counts from the live server

#### Scenario: Filtered logs
- **WHEN** the user runs `open-deepwiki logs --repo myrepo`
- **THEN** only event lines for that repo are shown

#### Scenario: Build progress is readable
- **WHEN** repos are mid-build across several nights
- **THEN** `status` shows each one's pinned commit and attempts used, distinguishing them from stale and failed repos

#### Scenario: Migration progress is readable
- **WHEN** some repos have been migrated to the `claude` producer and others have not
- **THEN** `status --json` distinguishes them by producer, so grounding and health can be compared per producer

### Requirement: Append-only event log
The system SHALL append structured events (JSONL: `run_started`, `run_succeeded`, `run_failed`, `run_rate_limited`, `queue_enqueued`, with ts, repoId, producer, duration, grounding score, token usage, error) to `<dataDir>/events.jsonl` from indexing and scheduler runs, rotating the file (truncate to zero) when it exceeds a configurable size (default 10MB). The event log SHALL be the debugging forensic trail and SHALL NOT gate any runtime behavior.

#### Scenario: Failed run recorded
- **WHEN** a producer update for a repo exits non-zero
- **THEN** a `run_failed` event with the error summary is appended for that repo

#### Scenario: Rate limit recorded distinctly
- **WHEN** a run ends because the producer's usage limit is exhausted
- **THEN** a `run_rate_limited` event is appended and no `run_failed` event is written for that run

#### Scenario: Rotation on size
- **WHEN** `events.jsonl` exceeds the configured rotation size
- **THEN** it is truncated and new events continue from an empty file
