## ADDED Requirements

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
