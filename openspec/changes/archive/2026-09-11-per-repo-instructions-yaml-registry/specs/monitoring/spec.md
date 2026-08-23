## MODIFIED Requirements

### Requirement: Deterministic repo health classification
The system SHALL compute per-repo health as: **red** when the last run failed, **yellow** when `now − last_success > 2× expected update interval` (from the repo's schedule), **green** otherwise. The classification SHALL be derived at read time from the run state store, not stored.

#### Scenario: Failed run marks repo red
- **WHEN** a repo's most recent openwiki run failed
- **THEN** `/status` and CLI `status` report it as red with the error message

#### Scenario: Stale repo marked yellow
- **WHEN** a repo on the nightly schedule has had no successful update for more than two days
- **THEN** it is reported yellow

### Requirement: CLI status and logs
The system SHALL provide `open-deepwiki status` printing a per-repo table (repoId, health, last success, sha, docs, link health, last error), with `--failing` (red/yellow only), `--json` (machine-readable), and `--server <url>` (merge live scheduler/queue state from the running server's `/status` using the configured token; bare `status` falls back to the state-store-only view). The system SHALL provide `open-deepwiki logs [--repo <repoId>]` tailing the event log with line filtering.

#### Scenario: Status table from registry
- **WHEN** the user runs `open-deepwiki status`
- **THEN** every registered repo is listed with its computed health, last success time, and last error if any

#### Scenario: Live queue merge
- **WHEN** the user runs `open-deepwiki status --server http://host:7245` while a nightly batch is running
- **THEN** the output includes current queue pending/in-flight counts from the live server

#### Scenario: Filtered logs
- **WHEN** the user runs `open-deepwiki logs --repo myrepo`
- **THEN** only event lines for that repo are shown
