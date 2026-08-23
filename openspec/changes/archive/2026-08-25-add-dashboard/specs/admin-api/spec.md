# Admin API Specification

## Purpose

The write surface behind the dashboard (and usable by any HTTP client): repo
add/update/remove and instructions editing on the `serve` process, reusing
the same pipeline, locks, and registry as the CLI.

## ADDED Requirements

### Requirement: Add repository with pre-flight validation
The server SHALL accept `POST /api/repos` with a JSON body `{ "source": "<git-url|local-path>" }`. Before registering, it SHALL validate the source with a fast pre-flight check — `git ls-remote` for remote URLs, existence plus a git-worktree check for local paths — and reject failures with 400 and a clear error, registering nothing. An already-registered source SHALL be rejected with 409. On success the server SHALL register the repo (same repoId normalization and duplicate handling as the CLI) and start the initial pipeline run.

#### Scenario: Unreachable remote rejected
- **WHEN** a client posts a git URL that `git ls-remote` cannot reach
- **THEN** the response is 400 with the pre-flight error and no repo is registered

#### Scenario: Duplicate source rejected
- **WHEN** a client posts a source that is already registered
- **THEN** the response is 409 and the registry is unchanged

#### Scenario: Valid source accepted
- **WHEN** a client posts a valid local git path
- **THEN** the response is 202 with the assigned repoId and the repo appears in the registry

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
