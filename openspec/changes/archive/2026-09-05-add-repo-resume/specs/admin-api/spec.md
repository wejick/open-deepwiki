## ADDED Requirements

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
