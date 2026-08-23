## ADDED Requirements

### Requirement: Repository registration
The system SHALL support adding a repo by remote git URL or local filesystem path using pure git operations (clone via the server's own git credentials — SSH key or credential helper; no hosting-provider APIs), assigning a stable unique `repoId` normalized as a `host/group/name` slug (subgroup-safe for GitLab group hierarchies, collision-suffixed when needed), and persisting the registry (repoId, source, local clone path, schedule, options) under the data directory.

#### Scenario: Add remote repo
- **WHEN** the user runs `repo add git@gitlab.corp:team/subgroup/repo.git`
- **THEN** the repo is cloned via plain git into `<dataDir>/repos/<repoId>/checkout`, registered with repoId `gitlab.corp/team/subgroup/repo`, and queued for initial indexing

#### Scenario: Add duplicate repo
- **WHEN** the user adds a source that is already registered
- **THEN** the command fails with a clear error and does not duplicate the entry

### Requirement: Batch import
The system SHALL support registering many repos at once via `repo add --from-file <file>` (one git URL per line), processed through a work queue whose maximum parallelism is configurable (default 2) for clone + openwiki init + initial indexing, with progress output.

#### Scenario: Batch import respects concurrency cap
- **WHEN** the user imports a file containing 100 git URLs with max parallelism set to 2
- **THEN** at most 2 repos are being cloned/indexed simultaneously and progress is reported per repo as it completes

### Requirement: Repository removal and listing
The system SHALL support removing a repo (deleting its registration and clone, and transactionally purging all of its rows — chunks, vectors, edges, centroid — from the shared index database) and listing all registered repos with their status (last indexed sha, last update time, document count, link health — resolved vs total concept edges, auto-derived concept terms, and last run duration/cost when recorded).

#### Scenario: Remove repo
- **WHEN** the user runs `repo remove <repoId>`
- **THEN** the registration and local clone are deleted and the repo's rows no longer appear in any search result

#### Scenario: List repos
- **WHEN** the user runs `repo list`
- **THEN** all registered repos are shown with repoId, source, last indexed sha, document count, link health, and auto-derived concept terms

### Requirement: Scheduled updates
The system SHALL run a nightly batch scheduler (configurable time, default 02:00, processed as a staggered queue) that for each registered remote repo fetches and pulls the latest changes, runs the openwiki update (`openwiki --update`) only when the head moved, and triggers incremental re-indexing of the changed bundle and changed/deleted source files. Per-repo schedule overrides SHALL be supported (more or less frequent than the default). The scheduler SHALL run in-process with the server and SHALL also be invokable as a standalone CLI command (`update --all`) for system-cron/launchd operation.

#### Scenario: Nightly run with changes triggers incremental re-index
- **WHEN** the nightly batch finds new commits in a repo
- **THEN** the system runs `openwiki --update`, computes the changed/deleted source file set via `git diff` between the last indexed sha and the new head, and re-indexes only the changed bundle concepts and source files

#### Scenario: Pull with no changes
- **WHEN** a scheduled update finds the repo already at the last indexed sha
- **THEN** no openwiki run or re-indexing work is performed

#### Scenario: Per-repo override honored
- **WHEN** a repo is registered with an hourly override while the default is nightly
- **THEN** that repo is updated hourly and the rest nightly

### Requirement: Update concurrency safety
The system SHALL prevent overlapping update runs for the same repo using a per-repo lock, skipping and logging runs that collide with an in-progress update, and SHALL bound concurrent openwiki runs across repos by the configured maximum parallelism.

#### Scenario: Overlapping run skipped
- **WHEN** a scheduled update starts while a previous update for the same repo is still running
- **THEN** the new run is skipped and a message is logged

### Requirement: Run observability
The system SHALL record per-repo run metadata (start/end time, outcome, duration, and token usage when reported by the CLI) in the registry for cost visibility.

#### Scenario: Cost of a wiki run recorded
- **WHEN** an `openwiki --init`/`--update` run completes
- **THEN** the registry entry for that repo includes the run's duration and token usage (when available)
