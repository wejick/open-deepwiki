## ADDED Requirements

### Requirement: Per-repo producer override
The registry SHALL store an optional producer for each repo, settable at registration and changeable afterwards, overriding the configured global default. Changing a repo's producer SHALL NOT discard its existing bundle, continuity metadata, or index — the next update continues the existing wiki. `repo list` SHALL report the producer in effect for each repo.

#### Scenario: Migrate one repo without touching the rest
- **WHEN** a single repo's producer is changed from `openwiki` to `claude`
- **THEN** only that repo's next run uses `claude`, and its existing bundle and index remain in place and queryable

#### Scenario: Rollback continues the same wiki
- **WHEN** a repo's producer is changed back to `openwiki` after `claude` runs
- **THEN** the next update is incremental from the recorded commit, not a full regeneration

#### Scenario: Producer visible in listing
- **WHEN** the user runs `repo list` with a mix of overridden and default repos
- **THEN** each row shows the producer that will run for that repo

## MODIFIED Requirements

### Requirement: Scheduled updates
The system SHALL run a nightly batch scheduler (configurable time, default 02:00, processed as a staggered queue) that for each registered remote repo fetches and pulls the latest changes, runs the selected producer's update only when the head moved, and triggers incremental re-indexing of the changed bundle and changed/deleted source files. Per-repo schedule overrides SHALL be supported (more or less frequent than the default). The scheduler SHALL run in-process with the server and SHALL also be invokable as a standalone CLI command (`update --all`) for system-cron/launchd operation.

Because a batch can be cut short by an exhausted budget, dispatch order SHALL be deterministic and fair: repos SHALL be ordered by staleness, least recently succeeded first, and repos resuming or updating SHALL be dispatched ahead of repos requiring a first full build, so that adding a repo never stalls the rest of the fleet. A repo pinned to a target commit SHALL NOT be pulled. When a run reports `rate_limited`, the scheduler SHALL stop dispatching further runs for that producer in the current batch and leave the remaining repos unprocessed rather than running them into the same limit; a recorded reset time SHALL be respected before the repo is retried.

#### Scenario: Nightly run with changes triggers incremental re-index
- **WHEN** the nightly batch finds new commits in a repo
- **THEN** the system runs the selected producer's update, computes the changed/deleted source file set via `git diff` between the last indexed sha and the new head, and re-indexes only the changed bundle concepts and source files

#### Scenario: Pull with no changes
- **WHEN** a scheduled update finds the repo already at the last indexed sha
- **THEN** no producer run or re-indexing work is performed

#### Scenario: Per-repo override honored
- **WHEN** a repo is registered with an hourly override while the default is nightly
- **THEN** that repo is updated hourly and the rest nightly

#### Scenario: A truncated batch still makes fleet-wide progress
- **WHEN** successive nightly batches are each cut short by an exhausted budget partway through the fleet
- **THEN** each batch processes the least recently succeeded repos first, so every repo is reached over successive nights rather than the same repos being reprocessed

#### Scenario: A first build does not stall updates
- **WHEN** a newly added repo needing a full build is queued alongside repos needing small updates
- **THEN** the updates are dispatched first and the full build takes the remaining budget

#### Scenario: Pinned repo is not pulled
- **WHEN** the batch reaches a repo pinned to a target commit by an in-progress build
- **THEN** no pull occurs and the repo continues building against that commit

#### Scenario: Batch pauses on rate limit
- **WHEN** a repo's run reports `rate_limited` partway through a nightly batch
- **THEN** the remaining repos using that producer are left unprocessed for this batch, and none of them is recorded as failed

### Requirement: Run observability
The system SHALL record per-repo run metadata (start/end time, outcome, duration, the producer that ran, the bundle's grounding score, and token usage when reported by the CLI) in the registry for cost visibility. The recorded outcome SHALL distinguish `success`, `failed`, and `rate_limited`. For a repo with an in-progress build the registry SHALL also record the pinned target commit and the number of resume attempts consumed.

#### Scenario: Cost of a wiki run recorded
- **WHEN** an `openwiki --init`/`--update` run completes
- **THEN** the registry entry for that repo includes the run's duration and token usage (when available)

#### Scenario: Producer and grounding recorded
- **WHEN** a run completes under either producer
- **THEN** the registry entry records which producer ran and the grounding score of the accepted bundle

#### Scenario: Rate-limited run does not overwrite last success
- **WHEN** a run ends as `rate_limited`
- **THEN** the outcome is recorded and the repo's last successful run timestamp and sha are left unchanged

#### Scenario: Resume progress is visible
- **WHEN** a repo's build has been cut short and resumed
- **THEN** the registry records the pinned target commit and how many resume attempts have been used
