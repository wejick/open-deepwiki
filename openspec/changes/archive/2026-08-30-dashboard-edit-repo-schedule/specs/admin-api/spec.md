## ADDED Requirements

### Requirement: Schedule endpoints
The server SHALL accept `GET /api/repos/:id/schedule` returning
`{ "schedule": <string|null> }` — the repo's per-repo cron override, null when
it follows the default nightly schedule — and `PUT /api/repos/:id/schedule`
with `{ "schedule": <string|null> }`. A PUT whose value is null, empty, or
whitespace-only SHALL clear the override; a non-empty value SHALL first be
validated as a cron expression and, when invalid, rejected with 400 and an
error naming the problem, persisting nothing and leaving the previous override
in effect. A valid value SHALL be persisted to the human-owned registry
(`registry.yaml` only — `state.json` untouched) and SHALL NOT start any run.
Both endpoints SHALL return 404 for an unregistered repoId.

#### Scenario: Round-trip schedule
- **WHEN** a client puts a valid cron expression for a repo and then gets its schedule
- **THEN** the get returns exactly the stored expression

#### Scenario: Clearing the override
- **WHEN** a client puts an empty string for a repo that has a schedule override
- **THEN** the override is cleared and a subsequent get returns null

#### Scenario: Invalid cron rejected
- **WHEN** a client puts a value that is not a valid cron expression
- **THEN** the response is 400 with an error naming the problem, the registry still holds the previous override, and no schedule change takes effect

#### Scenario: Save persists without running
- **WHEN** a client puts a valid schedule for a repo
- **THEN** only the save is performed — no update request is started and the registry's machine-owned state store is unchanged

#### Scenario: Unknown repo rejected
- **WHEN** a schedule request names an unregistered repoId
- **THEN** the response is 404 for both the get and the put
