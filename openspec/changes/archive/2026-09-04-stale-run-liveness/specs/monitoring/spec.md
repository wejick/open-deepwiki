## MODIFIED Requirements

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
