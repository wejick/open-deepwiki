# Monitoring Specification — delta for add-dashboard

## MODIFIED Requirements

### Requirement: Health and status endpoints
The system SHALL expose `GET /healthz` (no token; minimal liveness payload: ok flag, uptime, repo count) and `GET /status` (bearer-token-protected by the same middleware as MCP) returning JSON with: scheduler state (next run, last tick, queue pending/in-flight/max-parallel, locks held) and per-repo status entries (repoId, health, last success time, last indexed sha, document count, link health, last error, last run duration, token usage when recorded, and the last run's start and finish times so in-flight runs are observable), plus aggregate counts.

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
