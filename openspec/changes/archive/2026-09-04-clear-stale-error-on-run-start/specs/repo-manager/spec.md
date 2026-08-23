## MODIFIED Requirements

### Requirement: Run observability
The system SHALL record per-repo run metadata in the machine-owned state store: finish time, outcome, duration, the bundle's grounding score, and — for a rate-limited run — the reset time the producer reported. The recorded outcome SHALL distinguish `success`, `failed`, and `rate_limited`.

Every path that finishes a run SHALL record it through one recorder, so that no caller can flatten `rate_limited` to `failed` or drop the reset time and grounding score. That recorder SHALL be the only writer of the last-run block's outcome fields, the last indexed sha, and the last-success timestamp; it SHALL advance the latter two only for a successful run, so a rate-limited run leaves last-success state exactly where it was.

Every path that marks a run started (`repo add`, `update <repoId>`, `repo reinit`, and their admin API equivalents) SHALL do so through one start marker that sets the start time, clears the finish time, and clears a previously recorded error — a stale error describes a run that has been superseded and SHALL NOT persist through the run that supersedes it. The start marker SHALL NOT touch the outcome, duration, reset time, grounding score, last indexed sha, or last-success timestamp, so the health color and last-success state stand unchanged until the new run records its outcome.

Two fields are deliberately not in the state store:

- **The producer that ran** is derived at read time from the per-repo override and the global default. The producer that actually *wrote* a bundle is recorded in that bundle's own continuity metadata (`openwiki/.last-update.json`), which is the durable record; the derived value reports what the next run would use.
- **The pinned target commit and resume attempts consumed** live in the work-in-progress area's own metadata, and are surfaced through status rather than copied into the registry, so there is one writer per fact.

**Not recorded:** token usage. The field exists in the state store and in the status payload but is always null — no producer's usage figures are threaded through, so per-repo cost cannot be summed from it. A run's start time is set by the single-repo paths (`repo add`, `update <repoId>`, `repo reinit`, the admin API) and left null by the nightly batch, so an in-flight batch run is visible through the scheduler state rather than through a run start time.

#### Scenario: Duration of a wiki run recorded
- **WHEN** a producer run completes under either producer
- **THEN** the registry entry for that repo records the run's finish time and duration

#### Scenario: Grounding recorded
- **WHEN** a run completes under either producer
- **THEN** the registry entry records the grounding score of the accepted bundle, and status reports the producer in effect for that repo

#### Scenario: Rate-limited run does not overwrite last success
- **WHEN** a run ends as `rate_limited`
- **THEN** the outcome is recorded as `rate_limited` with its reset time, and the repo's last successful run timestamp and last indexed sha are left unchanged

#### Scenario: The nightly batch records the same outcomes as the CLI
- **WHEN** a rate-limited run happens inside a nightly batch rather than a single-repo command
- **THEN** it is recorded as `rate_limited` with its reset time, exactly as the single-repo path records it, and the repo does not read as failed

#### Scenario: Resume progress is visible
- **WHEN** a repo's build has been cut short and resumed
- **THEN** status reports the pinned target commit and how many resume attempts have been used, read from the work-in-progress metadata

#### Scenario: Stale error cleared when a run starts
- **WHEN** a repo's last recorded run failed with an error and a single-repo update or re-initialization is started (CLI or admin API)
- **THEN** the recorded error is cleared as the run is marked started, while the recorded outcome, last indexed sha, and last-success timestamp are left unchanged until the new run records
