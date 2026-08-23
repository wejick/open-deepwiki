## ADDED Requirements

### Requirement: Producer contract
The system SHALL hold every OKF producer to one contract. Given the managed clone, the run mode, the commit the existing bundle was generated from, the source paths changed since that commit, and the frontmatter `type` vocabulary already in use, a producer SHALL write the OKF bundle to `<clone>/openwiki/`, SHALL modify nothing else in the checkout, and SHALL report exactly one outcome: `ok`, `failed`, or `rate_limited`. Bundle acceptance — conformance, grounding, scoped-update checks, repair retry, snapshot restore, and continuity metadata — SHALL be performed by the system identically for every producer and SHALL NOT be delegated to a producer. Producers SHALL reuse the existing run cycle: the per-repo lock, the queue, and the run event sequence SHALL be the same regardless of which producer ran.

#### Scenario: Acceptance is identical across producers
- **WHEN** either producer completes a run
- **THEN** the bundle passes through the same conformance, grounding, scoped-update, and isolation path, with no producer-specific bypass

#### Scenario: Run cycle is unchanged by producer choice
- **WHEN** the same repo is run once under each producer
- **THEN** both runs take the per-repo lock and emit the same sequence of run events, differing only in the recorded producer and outcome

#### Scenario: Self-diffing producer ignores the supplied change set
- **WHEN** a producer that derives its own change set is given one
- **THEN** it ignores the supplied paths and the run's acceptance is unaffected

### Requirement: Producer selection
The system SHALL select the OKF producer by id from configuration, defaulting to `openwiki`, with a per-repo value taking precedence over the global default. Selecting a producer SHALL NOT change how the bundle is verified, indexed, or served. When the selected producer cannot run because its prerequisite is absent, the system SHALL apply one policy for every producer: warn, skip wiki generation, and continue with source-only indexing, leaving any existing bundle queryable.

#### Scenario: Default producer
- **WHEN** no producer is configured
- **THEN** the `openwiki` producer runs, preserving existing behavior

#### Scenario: Per-repo override wins
- **WHEN** the global producer is `openwiki` and a repo is registered with the `claude` producer
- **THEN** that repo's runs use the `claude` producer and every other repo continues using `openwiki`

#### Scenario: Unknown producer id rejected
- **WHEN** a producer id that no producer implements is configured
- **THEN** the run fails with an error naming the unknown id and listing the available producers, and the repo's bundle and index are untouched

#### Scenario: Missing prerequisite degrades the same way for either producer
- **WHEN** the selected producer's CLI is not on `PATH`, whether that is `openwiki` or `claude`
- **THEN** a warning naming that producer is recorded, source-only indexing proceeds, and any existing bundle and index remain queryable

### Requirement: Non-interactive Claude Code producer invocation
The `claude` producer SHALL invoke the `claude` CLI in non-interactive print mode against the managed clone, one-shot, with stdout/stderr captured and a configurable timeout. The invocation SHALL be constrained so the producer can only read the checkout and write the bundle: no shell execution, no network tools, and no access to paths outside the clone. Authoring guidance SHALL come from a repo-owned skill that carries the OKF v0.2 contract, so the prompt is versioned with the code rather than embedded in it.

#### Scenario: Init run produces a bundle
- **WHEN** a repo is added with the `claude` producer selected
- **THEN** the CLI completes non-interactively and an OKF bundle directory exists at `<clone>/openwiki/`

#### Scenario: Producer cannot execute repository code
- **WHEN** the `claude` producer runs against a checkout containing executable scripts
- **THEN** no shell command from the repository is executed during the run

#### Scenario: Producer cannot write outside the bundle
- **WHEN** a run attempts to modify a source file in the checkout
- **THEN** the write does not occur and the checkout's tracked files are unchanged after the run

#### Scenario: Timeout kills the run
- **WHEN** a run exceeds the configured producer timeout
- **THEN** the child process is terminated and the run is reported as timed out

### Requirement: Wiki continuity metadata
Every producer SHALL read `<clone>/openwiki/.last-update.json` before an update to determine the commit the wiki was last generated from, and SHALL write it back after a successful run recording the current head. The file SHALL retain the field names and value shapes openwiki reads (`updatedAt`, `command`, `gitHead`, `model`, `status`, `language`), so a bundle produced by either producer can be continued by the other. Producer-specific additions SHALL be extension fields that do not alter existing field meanings.

#### Scenario: Claude producer continues an openwiki bundle
- **WHEN** a repo whose bundle was generated by `openwiki` at commit A is updated by the `claude` producer at commit B
- **THEN** the producer scopes its work to the A..B change set and the metadata file records `gitHead` B

#### Scenario: openwiki resumes a Claude-authored bundle
- **WHEN** a repo whose bundle was last written by the `claude` producer is switched back to `openwiki` and updated
- **THEN** openwiki reads the recorded `gitHead` and performs an incremental update rather than a full regeneration

#### Scenario: Anchor survives a failed run
- **WHEN** an update fails and the last verified bundle is restored
- **THEN** the restored `.last-update.json` records the previously indexed commit, so the next update re-attempts the same change set

### Requirement: Scoped updates preserve existing conventions
On an update run, a producer SHALL be given the set of source paths changed since the recorded `gitHead`, SHALL revise only the wiki pages affected by those changes, and SHALL preserve the existing bundle's conventions — a page outside the change set SHALL NOT have its `type` reassigned, and concept pages unrelated to the change set SHALL remain byte-identical. A genuinely new page introduced by the change set MAY carry a `type` not previously in use. Structural files that legitimately track other pages (directory indexes and changelogs) SHALL be exempt from the byte-identity check, which governs authored content only. A run whose bundle change is disproportionate to the code change SHALL be rejected as a verification failure.

#### Scenario: Unrelated pages untouched
- **WHEN** an update run covers a change set touching one module
- **THEN** concept pages for unrelated modules are byte-identical to their pre-run content

#### Scenario: Index regeneration is not a violation
- **WHEN** an update adds a page and the section index listing it is regenerated
- **THEN** the index change is not counted as touching an unrelated page

#### Scenario: Existing page's type is not reassigned
- **WHEN** an update run revises a page whose change is unrelated to its `type`
- **THEN** that page's `type` value is unchanged from its pre-run content

#### Scenario: A new page may introduce a new type
- **WHEN** an update run's change set adds a page describing a kind of unit the bundle had no page for
- **THEN** that page's `type` is accepted even if no existing page used that value

#### Scenario: Disproportionate rewrite rejected
- **WHEN** an update run rewrites a share of the bundle far exceeding the share of source files changed
- **THEN** the run is reported as a verification failure and the last verified bundle is restored

### Requirement: Bundle grounding verification
After each producer run, the system SHALL verify that source paths cited by wiki pages resolve in the checkout at the indexed commit, and SHALL compute the resolved fraction as the bundle's grounding score. A run whose grounding score falls below a configured floor SHALL be treated as a verification failure. Because a bundle that cites nothing trivially resolves everything it cites, the system SHALL also require a minimum citation density and SHALL treat a bundle below it as a verification failure regardless of its resolved fraction. The score SHALL be recorded for the repo so grounding regressions are observable over time.

#### Scenario: Fabricated citation fails the run
- **WHEN** a run produces pages citing source paths that do not exist in the checkout, pushing the grounding score below the floor
- **THEN** the run is reported as a verification failure and the last verified bundle is restored

#### Scenario: Grounded bundle accepted and scored
- **WHEN** a run produces pages whose citations all resolve, at or above the required density
- **THEN** the bundle is accepted and a grounding score of 1 is recorded for the repo

#### Scenario: Bundle that cites nothing is rejected
- **WHEN** a run produces pages that cite few or no source paths, so the resolved fraction is vacuously perfect
- **THEN** the run is rejected for insufficient citation density rather than accepted with a passing score

#### Scenario: Deleted code surfaces as decay
- **WHEN** source files cited by existing wiki pages are deleted upstream and the repo is updated
- **THEN** the recorded grounding score decreases, making the stale pages observable

### Requirement: Initial bundles must cover the repository
Because an initial run has no previous bundle to compare against, conformance and grounding alone cannot detect a bundle truncated by an exhausted context. After an initial run the system SHALL measure how much of the repository's source structure the bundle accounts for, and SHALL treat a bundle below a configured coverage floor as a verification failure.

#### Scenario: Truncated initial bundle rejected
- **WHEN** an initial run returns a well-formed bundle whose pages resolve, but which accounts for only a small fraction of the repository's source directories
- **THEN** the run is reported as a verification failure rather than accepted

#### Scenario: Coverage is not required of updates
- **WHEN** an update run revises a small number of pages for a small change set
- **THEN** no coverage floor is applied, because the scoped-update checks govern that run

### Requirement: Repair retry before failure
When a run completes but its bundle fails verification, the system SHALL re-invoke the same producer exactly once with the specific verification errors, and SHALL accept the bundle if the retry passes. When the failure is that the producer changed too much, the retry SHALL start from the pre-run bundle rather than the over-broad output, so the producer has an unmodified reference to work from instead of its own rejected result. A retry SHALL NOT be attempted for a run that failed to execute (spawn error, non-zero exit, timeout, or rate limit).

#### Scenario: Repair fixes a malformed page
- **WHEN** a run yields a page with missing frontmatter and the repair retry adds it
- **THEN** the bundle is accepted and no failure is reported for the repo

#### Scenario: Repair exhausted
- **WHEN** the repair retry still fails verification
- **THEN** the run is reported as failed, the last verified bundle is restored, and no further retry is attempted

#### Scenario: No repair after a timeout
- **WHEN** a run times out
- **THEN** the failure is reported immediately without a repair retry

#### Scenario: Over-broad rewrite is retried from a clean base
- **WHEN** a run is rejected for changing a disproportionate share of the bundle
- **THEN** the retry is given the pre-run bundle, not the rejected output, as its starting point

### Requirement: Rate-limit outcome distinct from failure
When a producer cannot complete because its provider or subscription usage limit is exhausted, the system SHALL report a `rate_limited` outcome distinct from a failure. A rate-limited run SHALL leave the published bundle, index, and continuity metadata untouched, SHALL preserve any work-in-progress area, and SHALL NOT mark the repo as failed. When the producer reports a time at which the limit resets, the system SHALL record it so scheduling can avoid retrying before then.

#### Scenario: Rate limit does not mark the repo failed
- **WHEN** a run ends because the usage limit is exhausted
- **THEN** the outcome is recorded as `rate_limited`, the repo's last successful run is unchanged, and the bundle stays queryable

#### Scenario: Reset time recorded when reported
- **WHEN** a rate-limited run reports when the limit resets
- **THEN** that time is recorded with the outcome and the repo is not retried before it

### Requirement: Resumable production across runs
Production SHALL be resumable so that work lost to an exhausted budget is not repeated. A run SHALL produce into a work-in-progress area outside the published bundle, and the published bundle SHALL be replaced only when a complete work-in-progress bundle passes acceptance, as a single atomic promotion. A work-in-progress area SHALL record the target commit and the producer that created it. When a run ends without completing, the work-in-progress area SHALL be preserved and the next run for that repo SHALL continue from it rather than starting over. A work-in-progress area whose recorded producer differs from the currently selected one SHALL be discarded rather than resumed. The system SHALL bound resume attempts by a configured maximum; on exhaustion it SHALL stop retrying that repo, discard the work-in-progress area, and surface the repo as needing attention.

#### Scenario: Exhausted budget preserves partial work
- **WHEN** a run ends as `rate_limited` after producing part of a bundle
- **THEN** the partial output is preserved in the work-in-progress area and the published bundle and index are unchanged and still queryable

#### Scenario: Next run continues rather than restarting
- **WHEN** a repo with a preserved work-in-progress area is run again
- **THEN** the producer is given the partial bundle to continue, and pages already produced are not regenerated

#### Scenario: Promotion is all-or-nothing
- **WHEN** a work-in-progress bundle completes and passes acceptance
- **THEN** it replaces the published bundle in one atomic step, and at no point is a partial bundle readable at the published location

#### Scenario: Producer change discards partial work
- **WHEN** a repo's producer is changed while a work-in-progress area from the previous producer exists
- **THEN** that area is discarded and the next run starts a fresh bundle

#### Scenario: Attempts are bounded
- **WHEN** a repo reaches the configured maximum resume attempts without completing
- **THEN** retrying stops, the work-in-progress area is discarded, and the repo is reported as needing attention rather than retried on the next batch

### Requirement: Production pins the target commit
While a work-in-progress area exists for a repo, the system SHALL pin that repo to the commit recorded in it: the repo SHALL NOT be pulled and the target commit SHALL NOT advance until production completes or is abandoned. On completion the continuity metadata SHALL record the pinned commit as the commit the wiki was generated from.

#### Scenario: Pinned repo is not pulled
- **WHEN** a scheduled batch reaches a repo with a live work-in-progress area
- **THEN** no pull occurs, the recorded target commit is unchanged, and production continues against it

#### Scenario: Multi-run production converges
- **WHEN** a repo's production spans several runs because each is cut short by an exhausted budget
- **THEN** every run continues against the same pinned commit, and on completion the wiki is coherent for that commit and the metadata records it

#### Scenario: Forward progress resumes after promotion
- **WHEN** production completes for the pinned commit and the bundle is published
- **THEN** the repo is unpinned and the next scheduled run pulls and updates from that commit forward

## MODIFIED Requirements

### Requirement: Non-interactive openwiki invocation
When the `openwiki` producer is selected, the producer adapter SHALL invoke the pinned `openwiki` CLI as a child process — `openwiki --init` on first add and `openwiki --update` on subsequent runs — against the managed repo clone in one-shot non-interactive mode, capturing stdout/stderr, with a configurable timeout.

#### Scenario: Initial run produces a bundle
- **WHEN** a repo is added and the adapter runs `openwiki --init` on its fresh clone
- **THEN** the CLI completes non-interactively and an OKF bundle directory exists at `<clone>/openwiki/`

#### Scenario: Update run on unchanged repo
- **WHEN** the adapter runs `openwiki --update` on a repo whose head is unchanged since the last successful run
- **THEN** the CLI completes without regenerating wiki content (no-op run)

### Requirement: Version pinning
The adapter SHALL pin the openwiki CLI version (default from config, e.g. `^0.3`) and SHALL surface the installed version in diagnostics; a configured override SHALL be honored. The version check SHALL apply only to the `openwiki` producer; when the `claude` producer is selected the system SHALL instead surface that CLI's presence and reported version in diagnostics.

#### Scenario: Version mismatch warning
- **WHEN** the installed openwiki major version differs from the pinned expectation
- **THEN** the adapter logs a warning and still attempts the run

#### Scenario: Claude producer skips the openwiki pin
- **WHEN** the `claude` producer is selected and openwiki is not installed
- **THEN** no version warning is emitted and the run proceeds

### Requirement: OKF v0.2 bundle verification
After each producer run, the adapter SHALL verify the produced bundle conforms to OKF v0.2: every non-reserved `.md` file has parseable YAML frontmatter with a non-empty `type`, and the root `index.md` is present. Reserved files (`index.md`/`log.md` — structural table-of-contents and changelog files, which openwiki also emits at section subdirectories) SHALL be exempt from the frontmatter check at any depth.

#### Scenario: Valid bundle accepted
- **WHEN** a run finishes and every concept file parses with a non-empty `type`
- **THEN** the bundle is marked verified and handed to the indexer

#### Scenario: Malformed bundle rejected
- **WHEN** a run finishes but a concept file has missing frontmatter or an empty `type`
- **THEN** the adapter reports a verification failure for that run

#### Scenario: Verification is producer-independent
- **WHEN** the same bundle content is produced by either producer
- **THEN** the same verification result is reported

### Requirement: Failure isolation
If a producer run fails (non-zero exit, timeout, spawn error, or verification failure — including grounding, coverage, proportionality, and an exhausted repair retry), the adapter SHALL surface the error, preserve the last published bundle untouched, and leave the repo's indexed state unchanged. Because production happens in a work-in-progress area, the published bundle is never partially written and is restored only if an atomic promotion is interrupted. A `rate_limited` outcome SHALL preserve the published bundle in the same way, and SHALL additionally preserve the work-in-progress area for resumption, without being recorded as a failure.

#### Scenario: Failed update keeps last good bundle
- **WHEN** `openwiki --update` exits non-zero on a previously indexed repo
- **THEN** the error is reported and the previous OKF bundle and index remain in place and queryable

#### Scenario: Grounding failure keeps last good bundle
- **WHEN** a `claude` producer run is rejected for a grounding score below the floor
- **THEN** the previous OKF bundle, its continuity metadata, and the index remain in place and queryable
