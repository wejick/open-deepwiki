## ADDED Requirements

### Requirement: Live schedule updates
The running scheduler SHALL apply a per-repo schedule override change without
a restart: once the registry records a new, changed, or cleared override, the
repo's next scheduled run SHALL follow the recorded schedule and the
superseded schedule SHALL no longer fire the repo. Repos whose overrides were
not touched SHALL keep firing as before. An override that is not a valid cron
expression SHALL be ignored — the repo follows the default schedule and the
scheduler SHALL NOT fail — the same behavior as an invalid override read at
startup.

#### Scenario: Edited override takes effect without restart
- **WHEN** a repo's override is changed while the scheduler is running
- **THEN** the repo's next scheduled run follows the new expression and the previous expression no longer fires it

#### Scenario: Cleared override falls back to the default
- **WHEN** a repo's override is cleared while the scheduler is running
- **THEN** the repo's per-repo job is removed and the repo is covered by the default nightly job

#### Scenario: Invalid override ignored
- **WHEN** a running scheduler applies an override that is not a valid cron expression
- **THEN** no job is created for that expression, the scheduler keeps running, and the repo remains covered by the default job

#### Scenario: Untouched repos unaffected
- **WHEN** one repo's override is applied
- **THEN** the cron jobs of every other repo are unchanged
