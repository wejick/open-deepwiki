## MODIFIED Requirements

### Requirement: Repository registration
The system SHALL support adding a repo by remote git URL or local filesystem path using pure git operations (clone via the server's own git credentials — SSH key or credential helper; no hosting-provider APIs), assigning a stable unique `repoId` normalized as a `host/group/name` slug (subgroup-safe for GitLab group hierarchies, collision-suffixed when needed). The registry SHALL be a human-editable YAML file at `<dataDir>/registry.yaml` holding only human-owned fields (repoId, source, schedule, options, instructions); comments and formatting in the file SHALL be preserved when the system saves it. Machine-written run state (local clone path, added-at, last run metadata, last indexed sha, last success time) SHALL live in a separate `<dataDir>/state.json` keyed by repoId. When a legacy `<dataDir>/registry.json` exists, the system SHALL migrate it once to the YAML registry + state store.

#### Scenario: Add remote repo
- **WHEN** the user runs `repo add git@gitlab.corp:team/subgroup/repo.git`
- **THEN** the repo is cloned via plain git into `<dataDir>/repos/<repoId>/checkout`, registered with repoId `gitlab.corp/team/subgroup/repo` in the YAML registry, and queued for initial indexing

#### Scenario: Add duplicate repo
- **WHEN** the user adds a source that is already registered
- **THEN** the command fails with a clear error and does not duplicate the entry

#### Scenario: Legacy registry migrated
- **WHEN** the system starts with an existing `<dataDir>/registry.json` and no `registry.yaml`
- **THEN** the repos are migrated into `registry.yaml` (human fields) and `state.json` (run state) and the legacy file is left in place untouched

#### Scenario: Comments survive machine saves
- **WHEN** an operator hand-edits `registry.yaml` (comments, field order) and the system later saves the registry (e.g. after a run)
- **THEN** the operator's comments and formatting are preserved in the rewritten file

### Requirement: Repository removal and listing
The system SHALL support removing a repo (deleting its registration, its state entry, and its clone, and transactionally purging all of its rows — chunks, vectors, edges, centroid — from the shared index database) and listing all registered repos with their status (last indexed sha, last update time, document count, link health — resolved vs total concept edges, auto-derived concept terms, and last run duration/cost when recorded).

#### Scenario: Remove repo
- **WHEN** the user runs `repo remove <repoId>`
- **THEN** the registration, state entry, and local clone are deleted and the repo's rows no longer appear in any search result

#### Scenario: List repos
- **WHEN** the user runs `repo list`
- **THEN** all registered repos are shown with repoId, source, last indexed sha, document count, link health, and auto-derived concept terms

### Requirement: Run observability
The system SHALL record per-repo run metadata (start/end time, outcome, duration, and token usage when reported by the CLI) in the state store (`<dataDir>/state.json`) for cost visibility.

#### Scenario: Cost of a wiki run recorded
- **WHEN** an `openwiki --init`/`--update` run completes
- **THEN** the state store entry for that repo includes the run's duration and token usage (when available)
