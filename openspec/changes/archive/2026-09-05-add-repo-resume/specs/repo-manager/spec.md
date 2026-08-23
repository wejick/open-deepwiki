## ADDED Requirements

### Requirement: Resume a preserved build without pulling
The repo manager SHALL provide a resume run for a repo that has a preserved
build (a work-in-progress area recording a pinned target commit): it SHALL run
the same pipeline as an update at the pinned target commit — the producer
continues the preserved work and the index is brought up to the run's result —
and it SHALL NOT fetch or pull from the remote, even when the remote head has
moved. The resume SHALL NOT be skipped for being at its last indexed sha, and
the published bundle SHALL remain queryable until the run's own bundle is
accepted, with every failure mode of an ordinary run preserved (a failed
resume restores the last good bundle; a rate-limited or partial resume
preserves the work-in-progress area; run outcomes are recorded exactly like an
update's). A repo without a preserved build SHALL NOT be resumable: no run
starts and the repo's state is unchanged. A preserved build whose producer
differs from the one now selected, or whose resume attempts are exhausted, is
governed by the ordinary run rules (discard-and-fresh, and refuse-with-error
respectively) — resume adds no rule of its own.

#### Scenario: Resume runs at the pinned commit without pulling
- **WHEN** a repo has a preserved build pinned at a commit that is behind the remote head, and a resume run is requested
- **THEN** the run builds at the pinned commit, the recorded sha is the pinned one rather than the remote head, and no fetch or pull contacted the remote

#### Scenario: Resume is not skipped at the last indexed sha
- **WHEN** a repo has a preserved build whose pinned commit equals the repo's last indexed sha with a published bundle, and a resume run is requested
- **THEN** the run executes rather than reporting the repo already up to date

#### Scenario: Nothing to resume
- **WHEN** a resume run is requested for a repo with no preserved build
- **THEN** no run starts, the registry state is unchanged, and the outcome reports that there is nothing to resume

#### Scenario: Failed resume keeps the last good wiki
- **WHEN** a resume run's producer fails acceptance
- **THEN** the published bundle and index are as before the run, and the repo's last-run outcome records the failure

#### Scenario: Rate-limited resume stays resumable
- **WHEN** a resume run ends in a usage limit without completing a unit
- **THEN** the outcome is recorded as rate limited, the work-in-progress area survives with its attempt count advanced, and a later resume continues the same pinned build
