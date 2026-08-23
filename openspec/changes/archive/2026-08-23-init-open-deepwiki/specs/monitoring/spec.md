## ADDED Requirements

### Requirement: Health and status endpoints
The system SHALL expose `GET /healthz` (no token; minimal liveness payload: ok flag, uptime, repo count) and `GET /status` (bearer-token-protected by the same middleware as MCP) returning JSON with: scheduler state (next run, last tick, queue pending/in-flight/max-parallel, locks held) and per-repo status entries (repoId, health, last success time, last indexed sha, document count, link health, last error, last run duration, token usage when recorded), plus aggregate counts.

#### Scenario: Liveness check without token
- **WHEN** a monitoring probe calls `/healthz`
- **THEN** it receives 200 with a minimal ok payload and no repo details

#### Scenario: Full status with token
- **WHEN** an authenticated client calls `/status`
- **THEN** the response includes scheduler/queue state and one entry per registered repo with its last success, error, and cost fields

#### Scenario: Status requires token
- **WHEN** `/status` is called without a valid bearer token on a non-localhost bind
- **THEN** the server responds 401

### Requirement: Deterministic repo health classification
The system SHALL compute per-repo health as: **red** when the last run failed, **yellow** when `now − last_success > 2× expected update interval` (from the repo's schedule), **green** otherwise. The classification SHALL be derived at read time from registry state, not stored.

#### Scenario: Failed run marks repo red
- **WHEN** a repo's most recent openwiki run failed
- **THEN** `/status` and CLI `status` report it as red with the error message

#### Scenario: Stale repo marked yellow
- **WHEN** a repo on the nightly schedule has had no successful update for more than two days
- **THEN** it is reported yellow

### Requirement: CLI status and logs
The system SHALL provide `open-deepwiki status` printing a per-repo table (repoId, health, last success, sha, docs, link health, last error), with `--failing` (red/yellow only), `--json` (machine-readable), and `--server <url>` (merge live scheduler/queue state from the running server's `/status` using the configured token; bare `status` falls back to the registry-only view). The system SHALL provide `open-deepwiki logs [--repo <repoId>]` tailing the event log with line filtering.

#### Scenario: Status table from registry
- **WHEN** the user runs `open-deepwiki status`
- **THEN** every registered repo is listed with its computed health, last success time, and last error if any

#### Scenario: Live queue merge
- **WHEN** the user runs `open-deepwiki status --server http://host:7245` while a nightly batch is running
- **THEN** the output includes current queue pending/in-flight counts from the live server

#### Scenario: Filtered logs
- **WHEN** the user runs `open-deepwiki logs --repo myrepo`
- **THEN** only event lines for that repo are shown

### Requirement: Append-only event log
The system SHALL append structured events (JSONL: `run_started`, `run_succeeded`, `run_failed`, `queue_enqueued`, with ts, repoId, duration, token usage, error) to `<dataDir>/events.jsonl` from indexing and scheduler runs, rotating the file (truncate to zero) when it exceeds a configurable size (default 10MB). The event log SHALL be the debugging forensic trail and SHALL NOT gate any runtime behavior.

#### Scenario: Failed run recorded
- **WHEN** an openwiki update for a repo exits non-zero
- **THEN** a `run_failed` event with the error summary is appended for that repo

#### Scenario: Rotation on size
- **WHEN** `events.jsonl` exceeds the configured rotation size
- **THEN** it is truncated and new events continue from an empty file

### Requirement: server_status MCP tool
The server SHALL expose a `server_status` MCP tool returning the same summary as `/status` (scheduler/queue state, aggregate health counts, per-repo health with last error), so clients can ask conversational health questions ("why is repo X stale?") without knowing the URL.

#### Scenario: Health question via MCP
- **WHEN** a client calls `server_status`
- **THEN** the response contains queue state and per-repo health classifications with red repos including their last error
