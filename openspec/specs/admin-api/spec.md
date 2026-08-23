# Admin API Specification

## Purpose

TBD — synced from change add-dashboard (archived 2026-08-25).
## Requirements
### Requirement: Add repository with pre-flight validation
The server SHALL accept `POST /api/repos` with a JSON body
`{ "source": "<git-url|local-path>", "producer": "<producer-id>", "excludeGlobs": ["<glob>", ...] }`,
where `producer` and `excludeGlobs` are optional. Before registering, it SHALL
validate the source with a fast pre-flight check — `git ls-remote` for remote
URLs, existence plus a git-worktree check for local paths — and reject
failures with 400 and a clear error, registering nothing. An
already-registered source SHALL be rejected with 409. A `producer` value that
is present, non-empty, and not a known producer id SHALL be rejected with 400
and an error naming the valid ids, registering nothing and starting no run.
An absent, null, or empty `producer` SHALL record no per-repo override, so
the repo follows the global default — the same behavior as `repo add` without
`--producer`. A valid `producer` SHALL be persisted as that repo's override,
and the repo's first run SHALL use it. An `excludeGlobs` value SHALL be an
array of non-empty strings; any other shape — not an array, an empty or
whitespace-only entry, a non-string entry — SHALL be rejected with 400 and a
clear error, registering nothing and starting no run. Valid `excludeGlobs`
SHALL be persisted as the repo's per-repo exclude globs, merged additively
with the global exclude configuration for that repo's runs. An absent, null,
or empty `excludeGlobs` SHALL record no per-repo globs. On success the server
SHALL register the repo (same repoId normalization and duplicate handling as
the CLI), report the producer that will run, and start the initial pipeline
run.

#### Scenario: Unreachable remote rejected
- **WHEN** a client posts a git URL that `git ls-remote` cannot reach
- **THEN** the response is 400 with the pre-flight error and no repo is registered

#### Scenario: Duplicate source rejected
- **WHEN** a client posts a source that is already registered
- **THEN** the response is 409 and the registry is unchanged

#### Scenario: Valid source accepted
- **WHEN** a client posts a valid local git path
- **THEN** the response is 202 with the assigned repoId and the repo appears in the registry

#### Scenario: Producer override persisted
- **WHEN** a client posts a valid source with `producer` set to a known non-default id
- **THEN** the response is 202, the registered repo carries that producer as its override, and the reported producer is that id

#### Scenario: Omitted producer follows the global default
- **WHEN** a client posts a valid source with no `producer` field
- **THEN** the registered repo records no producer override, and the reported producer is the configured global default

#### Scenario: Unknown producer rejected before any work
- **WHEN** a client posts a source with a `producer` value no producer implements
- **THEN** the response is 400 with an error naming the valid producer ids, nothing is registered, and no pre-flight or pipeline work is performed

#### Scenario: Exclude globs persisted with the registration
- **WHEN** a client posts a valid source with `excludeGlobs: ["**/*.snap", "**/*.a"]`
- **THEN** the response is 202, the registered repo carries both globs, and its first run indexes no path matching them

#### Scenario: Malformed exclude globs rejected before any work
- **WHEN** a client posts a source with `excludeGlobs` set to a non-array, a non-string entry, or an empty string entry
- **THEN** the response is 400 with a clear error, nothing is registered, and no pre-flight or pipeline work is performed

#### Scenario: Omitted exclude globs record none
- **WHEN** a client posts a valid source with no `excludeGlobs` field, `null`, or an empty array
- **THEN** the registered repo records no per-repo globs and its runs use the global exclude list alone

### Requirement: Asynchronous run handling
Add and update endpoints SHALL run the pipeline asynchronously: the HTTP
response returns immediately after registration/validation (202), while the
run proceeds in-process under the per-repo lock. Run progress and outcome
SHALL be observable through the existing status surface (a started run
without a finish time indicates in-flight). A run request for a repo whose
lock is already held SHALL be rejected with 409.

#### Scenario: Add returns before the run completes
- **WHEN** a client posts a valid source whose pipeline run takes a long time
- **THEN** the response returns immediately with 202 and the run continues in the background

#### Scenario: Overlapping update rejected
- **WHEN** a client requests an update for a repo whose lock is held by an in-progress run
- **THEN** the response is 409 and no second run starts

### Requirement: Update repository endpoint
The server SHALL accept `POST /api/repos/:id/update`, returning 404 for an
unregistered repoId and otherwise starting the same update pipeline as
`repo update` (fetch/pull, wiki regeneration when the head moved,
incremental re-index) as an asynchronous run.

#### Scenario: Unknown repo rejected
- **WHEN** a client requests an update for an unregistered repoId
- **THEN** the response is 404 and no run starts

#### Scenario: Update runs the pipeline
- **WHEN** a client requests an update for a registered repo
- **THEN** the response is 202 and the repo's run state is updated when the background run completes

### Requirement: Resume repository endpoint
The server SHALL accept `POST /api/repos/:id/resume`, returning 404 for an
unregistered repoId, 409 while the repo's lock is held, and 409 with a clear
error when the repo has no preserved build to resume — in none of these cases
starting a run. Otherwise it SHALL start the resume run (the same pipeline as
`POST /api/repos/:id/update`, pinned to the preserved build's commit, without
pulling) as an asynchronous run, returning 202 immediately; progress and
outcome SHALL be observable through the existing status surface, and the
outcome SHALL be recorded like an update's.

#### Scenario: Unknown repo rejected
- **WHEN** a client requests a resume for an unregistered repoId
- **THEN** the response is 404 and no run starts

#### Scenario: Overlapping resume rejected
- **WHEN** a client requests a resume for a repo whose lock is held by an in-progress run
- **THEN** the response is 409 and no second run starts

#### Scenario: Nothing to resume rejected
- **WHEN** a client requests a resume for a registered, idle repo with no preserved build
- **THEN** the response is 409 with an error saying there is nothing to resume, and no run starts

#### Scenario: Resume runs the pipeline
- **WHEN** a client requests a resume for a repo with a preserved build
- **THEN** the response is 202, the run executes at the preserved build's pinned commit without pulling, and the repo's run state is updated when the background run completes

### Requirement: Remove repository endpoint
The server SHALL accept `DELETE /api/repos/:id`, returning 404 for an
unregistered repoId, 409 while the repo's lock is held, and otherwise
performing the same removal as `repo remove`: registration deleted, clone
removed, and all index rows for the repo purged transactionally.

#### Scenario: Remove while running rejected
- **WHEN** a client deletes a repo whose lock is held by an in-progress run
- **THEN** the response is 409 and the repo remains registered

#### Scenario: Remove purges everything
- **WHEN** a client deletes a registered, idle repo
- **THEN** the response is 200, the repo no longer appears in the registry or status, and its index rows are gone

### Requirement: Re-initialize repository endpoint
The server SHALL accept `POST /api/repos/:id/reinit`, returning 404 for an
unregistered repoId and otherwise starting the same re-initialization as
`repo reinit` — discard the repo's published bundle, verified snapshots, and
work-in-progress state, then rebuild it as an init from its existing clone —
as an asynchronous run. A request for a repo whose lock is held SHALL be
rejected with 409 and SHALL start no run. Re-initialization SHALL NOT
re-register, re-clone, or purge the repo's index rows. Run progress and outcome
SHALL be observable through the existing status surface, exactly as an update.

#### Scenario: Unknown repo rejected
- **WHEN** a client requests re-initialization for an unregistered repoId
- **THEN** the response is 404 and no run starts

#### Scenario: Overlapping re-initialization rejected
- **WHEN** a client requests re-initialization for a repo whose lock is held by an in-progress run
- **THEN** the response is 409 and no second run starts

#### Scenario: Re-initialization runs the pipeline
- **WHEN** a client requests re-initialization for a registered repo
- **THEN** the response is 202, the repo's wiki state is discarded and rebuilt
  as an init, and the run state is updated when the background run completes

### Requirement: Instructions endpoints
The server SHALL accept `GET /api/repos/:id/instructions` returning
`{ "instructions": <string|null> }` and `PUT /api/repos/:id/instructions`
with `{ "instructions": <string> }` persisting the text to the registry
(an empty or whitespace-only string clears it). Both SHALL return 404 for an
unregistered repoId. Saving SHALL NOT start any run.

#### Scenario: Round-trip instructions
- **WHEN** a client puts instructions for a repo and then gets them
- **THEN** the get returns exactly the stored text

#### Scenario: Clearing instructions
- **WHEN** a client puts an empty string for a repo with instructions
- **THEN** the repo's instructions are cleared from the registry

### Requirement: Admin API authentication
When the server is bound beyond localhost, every `/api/*` request SHALL
require a valid bearer token and be rejected with 401 otherwise. On a
localhost bind, no token SHALL be required.

#### Scenario: Unauthenticated admin request rejected on LAN bind
- **WHEN** the server is bound beyond localhost and an `/api/*` request arrives without a valid token
- **THEN** the response is 401 and no state changes

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

