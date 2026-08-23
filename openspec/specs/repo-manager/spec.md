# Repo Manager Specification

## Purpose

TBD — synced from change init-open-deepwiki (archived 2026-08-23).
## Requirements
### Requirement: Repository registration
The system SHALL support adding a repo by remote git URL or local filesystem path using pure git operations (clone via the server's own git credentials — SSH key or credential helper; no hosting-provider APIs), assigning a stable unique `repoId` normalized as a `host/group/name` slug (subgroup-safe for GitLab group hierarchies, collision-suffixed when needed), and persisting the registry (repoId, source, local clone path, schedule, options) under the data directory.

Because a `repoId` is unique only among *currently registered* repos, removing a repo and re-adding the same source hands the id straight back. Removal SHALL therefore delete every directory keyed by that id — the clone, the last-good snapshot, the pre-run snapshot, and the work-in-progress area — so that no state from the removed repo can be picked up by a later one holding the same id.

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

#### Scenario: Re-adding a removed source starts clean
- **WHEN** a repo with a live work-in-progress build is removed, and the same source is added again and given the same id
- **THEN** the new repo builds from scratch, with no partial bundle staged from the removed repo and no build reported in progress

#### Scenario: List repos
- **WHEN** the user runs `repo list`
- **THEN** all registered repos are shown with repoId, source, last indexed sha, document count, link health, and auto-derived concept terms

### Requirement: Repository re-initialization
The system SHALL support re-initializing a registered repo's wiki from its existing clone (`repo reinit <repoId>`). The command SHALL acquire the per-repo lock and be refused while another run holds it, then SHALL discard the repo's published bundle, its last-good snapshot and pre-run snapshot, and any work-in-progress build state, SHALL pull the existing clone when one is present, and SHALL run the repo through the initial-build pipeline — whole-repository planning, initial-coverage acceptance, and a full re-index. Registration, the clone, and the index rows SHALL be retained: the command SHALL NOT re-register, re-clone, or purge the repo. The run outcome SHALL be recorded through the same recorder as every other run. A failed re-initialization SHALL NOT restore the discarded bundle or snapshot: the checkout is left without a published wiki, and later runs for the repo rebuild it as an init, so the operator's request to rebuild from scratch is not silently converted into an incremental update of the wiki it discarded.

#### Scenario: Re-initialization rebuilds a repo from its existing clone
- **WHEN** `repo reinit` runs on a registered repo whose clone already exists
- **THEN** the published bundle, snapshot, and work-in-progress state are discarded, the clone is pulled to the current head and reused (not re-cloned), and an init run publishes a fresh bundle, re-indexes the repo, and records its outcome like any other run

#### Scenario: Re-initialization unblocks an exhausted work-in-progress build
- **WHEN** `repo reinit` runs on a repo whose work-in-progress state has exhausted its resume attempts — a state that otherwise stops every subsequent run
- **THEN** the work-in-progress state is discarded and the repo builds again

#### Scenario: A failed re-initialization leaves nothing published
- **WHEN** `repo reinit`'s init run fails
- **THEN** the discarded snapshot is not restored, the checkout has no published bundle, and subsequent runs for the repo execute as init builds

#### Scenario: Re-initialization is refused while another run holds the lock
- **WHEN** `repo reinit` reaches a repo whose per-repo lock is held
- **THEN** the command is refused with a busy message and changes no state

#### Scenario: Re-initialization refuses an unknown repo
- **WHEN** `repo reinit` names a repo that is not registered
- **THEN** the command exits 1 with an error and changes nothing

### Requirement: Scheduled updates
The system SHALL run a nightly batch scheduler (configurable time, default 02:00, processed as a staggered queue) that for each registered remote repo fetches and pulls the latest changes, runs the selected producer's update only when the head moved, and triggers incremental re-indexing of the changed bundle and changed/deleted source files. Per-repo schedule overrides SHALL be supported (more or less frequent than the default). The scheduler SHALL run in-process with the server and SHALL also be invokable as a standalone CLI command (`update --all`) for system-cron/launchd operation.

Because a batch can be cut short by an exhausted budget, dispatch order SHALL be deterministic and fair: repos SHALL be ordered by staleness, least recently succeeded first, and repos resuming or updating SHALL be dispatched ahead of repos requiring a first full build, so that adding a repo never stalls the rest of the fleet. A repo pinned to a target commit SHALL NOT be pulled. A repo whose recorded reset time is still in the future SHALL be ordered behind every repo that is not waiting, so it is reached only after the rest of the fleet, and SHALL NOT be dropped from the batch. Ordering SHALL be total: ties break on repoId.

A `rate_limited` run SHALL NOT halt the batch. The remaining repos are still dispatched, each is judged on its own outcome, and none is recorded as failed on account of another repo's limit. Fleet-level pausing is therefore a property of ordering, not of interruption.

**Not implemented:** a fleet-level circuit breaker that stops dispatching for a producer as soon as one of its runs reports `rate_limited`. The wording-independent signal such a breaker would consume (several *different* repos failing fast in a row) is computed by the `claude` producer as `suspectsRateLimit`, but nothing consumes it.

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

#### Scenario: Batch continues past a rate limit
- **WHEN** a repo's run reports `rate_limited` partway through a nightly batch
- **THEN** the remaining repos are still dispatched and judged on their own outcomes, and none of them is recorded as failed on account of that limit

#### Scenario: A repo waiting on a reset is reached last
- **WHEN** a batch contains a repo whose recorded reset time has not yet passed
- **THEN** it is ordered behind every repo that is not waiting, and is still attempted once they are done

### Requirement: Update flow derives the run mode from published state
The update flow SHALL determine a run's mode from the checkout's published-bundle
state, not from the command the run arrived through: a run SHALL execute with
update semantics only when a published bundle exists at the clone's bundle path,
and SHALL execute with init semantics otherwise — whatever entry point reached it,
including the scheduled batch and the standalone update command. A first build
recovered through the update path (for example, after a failed add left nothing
published) SHALL therefore receive init semantics: the producer is not told a
bundle exists, whole-repository planning applies (on a checkout beyond the split
threshold, planning is decomposed exactly as any init), initial-coverage
acceptance applies, and no scoped-update comparison is made against a
nonexistent prior bundle. The flow's no-op skip check SHALL respect the same
truth: a repo whose published bundle is absent SHALL NOT be skipped for being
already at the last indexed sha — except a repo configured without a wiki,
whose bundle is absent by configuration rather than by loss; it keeps the skip.

#### Scenario: Update on a repo with no published bundle runs as init
- **WHEN** the update flow reaches a repo whose checkout has no published bundle
- **THEN** the run executes with init semantics — whole-repository planning and initial-coverage acceptance — and the producer is not told a bundle exists

#### Scenario: Update on a repo with a published bundle keeps update semantics
- **WHEN** the update flow reaches a repo whose checkout has a published bundle
- **THEN** the run keeps update semantics — change-set-scoped planning and scoped-update acceptance — exactly as before

#### Scenario: A repo whose bundle is gone is rebuilt despite an unchanged head
- **WHEN** the update flow reaches a repo whose head equals the recorded last indexed sha but whose checkout has no published bundle
- **THEN** the run is not skipped and executes as an init

#### Scenario: A no-wiki repo at its indexed sha stays skipped
- **WHEN** the update flow reaches a repo configured without a wiki whose head equals the recorded last indexed sha
- **THEN** it is skipped exactly as before — its bundle is absent by configuration, not by loss — while a moved head still pulls and re-indexes it

#### Scenario: A failed first build recovered by the batch is an init
- **WHEN** a repo's initial run fails before anything is published and the scheduled batch later reaches it
- **THEN** the batch's run for that repo is an init run, and on a beyond-threshold checkout its planning is decomposed

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

### Requirement: Update concurrency safety
The system SHALL prevent overlapping update runs for the same repo using a per-repo lock, skipping and logging runs that collide with an in-progress update, and SHALL bound concurrent openwiki runs across repos by the configured maximum parallelism.

The lock SHALL record its holder's process id and start time. A lock whose recorded holder process is no longer alive SHALL be taken over immediately by the next acquirer, regardless of age. A lock whose recorded body cannot be parsed, or whose holder process appears alive, SHALL be taken over only after the staleness window (12 hours, from the lock file's modification time) — the age rule is the guard against a pid recycled by the operating system after a reboot. Taking a lock over SHALL replace the existing file and succeed; the acquisition SHALL NOT fail merely because the lock file exists.

#### Scenario: Overlapping run skipped
- **WHEN** a scheduled update starts while a previous update for the same repo is still running
- **THEN** the new run is skipped and a message is logged

#### Scenario: Dead holder taken over immediately
- **WHEN** a lock file exists whose recorded holder process is dead, whatever the file's age
- **THEN** the next acquisition attempt takes the lock over and proceeds instead of being skipped

#### Scenario: Live or unparseable lock blocks until the staleness window passes
- **WHEN** a lock file exists whose holder process is alive, or whose body cannot be parsed, and its age is under 12 hours
- **THEN** acquisition returns busy, and the colliding run is skipped and logged

#### Scenario: A stale lock is genuinely taken over
- **WHEN** a lock file's age exceeds the 12-hour staleness window
- **THEN** the next acquisition replaces the file and acquires the lock — the run proceeds rather than being skipped forever, including on the first attempt after the window passes

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

### Requirement: Registry write discipline
Writers SHALL persist only the store they own. Run-outcome writers — the
nightly batch, single-repo updates, and initial pipeline runs — SHALL write
only the machine-owned state store (`state.json`) and SHALL NOT rewrite the
human-owned `registry.yaml`. Human-config edits (such as instructions
changes) SHALL write only `registry.yaml` and SHALL NOT rewrite
`state.json`. Registration and removal SHALL write both. A `registry.yaml`
edit made while a batch run is in progress SHALL survive the batch's
completion save.

#### Scenario: Batch end leaves human config untouched
- **WHEN** the nightly batch completes and persists its run outcomes
- **THEN** `state.json` reflects the new outcomes and `registry.yaml` is byte-identical to before the save

#### Scenario: Mid-batch edit survives
- **WHEN** a repo's instructions are edited in the registry while the nightly batch holds its in-memory copy, and the batch then completes
- **THEN** the edited instructions are still present in `registry.yaml` after the batch's save

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

### Requirement: Per-repo exclude globs
The registry SHALL store an optional `excludeGlobs` glob list per repo, settable at registration via `repo add --exclude <glob>` (repeatable; comma-separated values accepted) and editable afterwards by editing `registry.yaml`. The effective exclude set for a repo SHALL be the configured global exclude globs merged additively with the repo's list — a repo's globs can only narrow what is indexed, never re-include a path the global list excludes. A repo without the field SHALL index exactly as before. `repo list` SHALL show a repo's exclude globs when set. A change to a repo's globs SHALL take effect on that repo's next indexing run.

#### Scenario: Register repo with excludes
- **WHEN** the user runs `repo add <source> --exclude "**/__snapshots__/**" --exclude "**/*.a"`
- **THEN** the registry entry records both globs, and the repo's first indexing run registers no chunks for paths matching them

#### Scenario: Repo globs extend, not replace, the global list
- **WHEN** the global config excludes `*.lock` and a repo declares `excludeGlobs: ["ci/**"]`
- **THEN** a file matching either list is excluded — the repo list removes `ci/**` files without re-including lock files

#### Scenario: Registry edit applies on next run
- **WHEN** a repo's `excludeGlobs` in `registry.yaml` is extended after its first run, and the repo is updated
- **THEN** chunks for files matched by the new globs no longer participate in search results, with no other index change

#### Scenario: Repo without excludes is unchanged
- **WHEN** a registered repo has no `excludeGlobs` entry
- **THEN** indexing and search behave exactly as with the global exclude list alone

#### Scenario: Excludes visible in listing
- **WHEN** the user runs `repo list` with one repo carrying exclude globs and one without
- **THEN** the first row shows its globs and the second shows none

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

### Requirement: Bare repo command defaults to listing
The CLI SHALL treat a `repo` invocation with no subcommand as `repo list`: the same listing of registered repos on stdout, the same empty-registry output, and exit code 0. The bare invocation SHALL additionally print a hint naming the available `repo` subcommands (`add`, `remove`, `list`, `update`, `reinit`, `instructions`) on **stderr**, so the stdout listing remains pipe-clean. A `repo` invocation with an unrecognized subcommand SHALL exit 1 with a usage message naming the available `repo` subcommands and SHALL NOT fall back to the listing.

#### Scenario: Bare invocation lists repos
- **WHEN** the user runs `repo` with no subcommand and repos are registered
- **THEN** stdout shows the same repo listing `repo list` would show, the exit code is 0, and stderr names the available `repo` subcommands

#### Scenario: Bare invocation with empty registry
- **WHEN** the user runs `repo` with no subcommand and no repos are registered
- **THEN** stdout shows the same "no repos registered" output as `repo list`, the exit code is 0, and stderr still names the available subcommands

#### Scenario: Unknown subcommand still fails
- **WHEN** the user runs `repo frobnicate`
- **THEN** the command exits 1 with a usage message naming the available `repo` subcommands, and no repo listing is printed

