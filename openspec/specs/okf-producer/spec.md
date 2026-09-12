# OKF Producer Specification

## Purpose

TBD — synced from change init-open-deepwiki (archived 2026-08-23).

## Requirements

### Requirement: Non-interactive openwiki invocation
When the `openwiki` producer is selected, the producer adapter SHALL invoke the pinned `openwiki` CLI as a child process — `openwiki --init` on first add and `openwiki --update` on subsequent runs — against the managed repo clone in one-shot non-interactive mode, capturing stdout/stderr, with a configurable timeout.

#### Scenario: Initial run produces a bundle
- **WHEN** a repo is added and the adapter runs `openwiki --init` on its fresh clone
- **THEN** the CLI completes non-interactively and an OKF bundle directory exists at `<clone>/openwiki/`

#### Scenario: Update run on unchanged repo
- **WHEN** the adapter runs `openwiki --update` on a repo whose head is unchanged since the last successful run
- **THEN** the CLI completes without regenerating wiki content (no-op run)

### Requirement: Isolated and pre-seeded openwiki configuration
The adapter SHALL run openwiki with an isolated openwiki home under the data directory — openwiki v0.3 hardcodes `~/.openwiki` (no config-dir env override), so the child process is spawned with `HOME=<dataDir>/openwiki-config`, where the adapter SHALL pre-seed provider credentials (from our config) before the first invocation, so that no interactive onboarding is required.

#### Scenario: First run without wizard
- **WHEN** `openwiki --init` is invoked with a pre-seeded config dir containing provider credentials
- **THEN** the run proceeds without prompting for provider, key, or model selection

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
If a producer run fails (non-zero exit, timeout, spawn error, or verification failure — including grounding, coverage, proportionality, and an exhausted repair retry), the adapter SHALL surface the error, preserve the last published bundle untouched, and leave the repo's indexed state unchanged. The restored bundle SHALL carry the continuity anchor of the run that produced it, so a failure cannot rewind the recorded `gitHead` to an earlier commit. Because production happens in a work-in-progress area, the published bundle is never partially written and is restored only if an atomic promotion is interrupted. A `rate_limited` outcome SHALL preserve the published bundle in the same way, and SHALL additionally preserve the work-in-progress area for resumption, without being recorded as a failure.

#### Scenario: Failed update keeps last good bundle
- **WHEN** `openwiki --update` exits non-zero on a previously indexed repo
- **THEN** the error is reported and the previous OKF bundle and index remain in place and queryable

#### Scenario: Grounding failure keeps last good bundle
- **WHEN** a `claude` producer run is rejected for a grounding score below the floor
- **THEN** the previous OKF bundle, its continuity metadata, and the index remain in place and queryable

### Requirement: Producer contract
The system SHALL hold every OKF producer to one contract. Given the managed clone, the run mode, the commit the existing bundle was generated from, the source paths changed since that commit, and the frontmatter `type` vocabulary already in use, a producer SHALL write the OKF bundle to `<clone>/openwiki/`, SHALL modify nothing else in the checkout, and SHALL report exactly one outcome: `ok`, `failed`, or `rate_limited`. Bundle acceptance — conformance, grounding, scoped-update checks, repair retry, snapshot restore, and continuity metadata — SHALL be performed by the system identically for every producer and SHALL NOT be delegated to a producer. Producers SHALL reuse the existing run cycle: the per-repo lock, the queue, and the terminal run event sequence SHALL be the same regardless of which producer ran. A producer with observable internal stages MAY interleave `producer_progress` events between the run's start and its terminal event; a producer that runs as a single child process emits none.

#### Scenario: Acceptance is identical across producers
- **WHEN** either producer completes a run
- **THEN** the bundle passes through the same conformance, grounding, scoped-update, and isolation path, with no producer-specific bypass

#### Scenario: Run cycle is unchanged by producer choice
- **WHEN** the same repo is run once under each producer
- **THEN** both runs take the per-repo lock and emit the same terminal sequence of run events, differing only in the recorded producer and outcome; a producer with observable stages may interleave `producer_progress` events between the lifecycle events

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
The `claude` producer SHALL invoke the `claude` CLI in non-interactive print mode against the managed clone, with stdout/stderr captured. A run SHALL be orchestrated as child sessions rather than one session: a planning session that produces the page plan, then the planned pages — each produced by its own child session, with up to a configurable number of page sessions running concurrently — and a final session for the overview page. A page session SHALL produce exactly one page and no session SHALL be asked to produce more than one. Each child session SHALL be bounded by a configurable per-session timeout, and the run as a whole SHALL be bounded by the existing configurable producer timeout, after which the orchestrator SHALL stop launching further sessions. The whole-run deadline SHALL be a single wall clock shared by every concurrent page session — it is not divided among workers and not extended by them — so a session that starts before the deadline remains bounded by its own per-session timeout computed against the remaining shared budget, and no session is terminated early to divide the budget among workers. When a page session reports a usage limit while other page sessions are in flight, the producer SHALL terminate the in-flight sessions, launch no further page session, and report the run as `rate_limited` with partial work preserved and the reset time that session reported; the overview session SHALL NOT run. When a run ends `failed` with several page sessions failed, the run's report SHALL carry the first failing session by launch order while every failed page is recorded individually in the run's notes. Every session SHALL be constrained so the producer can only read the checkout and write the bundle: no shell execution, no network tools, and no access to paths outside the clone other than the scratch file the planning session writes its plan to. Authoring guidance SHALL come from a repo-owned skill that carries the OKF v0.2 contract, so the prompt is versioned with the code rather than embedded in it; the guidance SHALL be composed as one contract shared by every session plus one phase-specific prompt per session kind. Each step — map (the area-map session), planning (the undecomposed planner session and every area session), and page (each page session, the overview session, and a repair session) — SHALL run on the run's model and effort unless a model or effort is separately configured for that step; an unset step value means the run-wide value, and a configured one applies to that step's sessions only.

#### Scenario: Init run produces a bundle
- **WHEN** a repo is added with the `claude` producer selected
- **THEN** the CLI completes non-interactively and an OKF bundle directory exists at `<clone>/openwiki/`

#### Scenario: Producer cannot execute repository code
- **WHEN** the `claude` producer runs against a checkout containing executable scripts
- **THEN** no shell command from the repository is executed during the run

#### Scenario: Producer cannot write outside the bundle
- **WHEN** a run attempts to modify a source file in the checkout
- **THEN** the write does not occur and the checkout's tracked files are unchanged after the run

#### Scenario: One session per planned page
- **WHEN** a plan containing several pages is generated
- **THEN** each page is produced by its own child session, and no session is asked to produce more than one page

#### Scenario: Page workers cap concurrency
- **WHEN** a run is configured with more than one page worker and its plan contains several pages
- **THEN** page sessions run concurrently with no more than the configured number in flight at once, and each session produces a distinct page

#### Scenario: Page workers default to one
- **WHEN** the page-worker count is not configured
- **THEN** page sessions run one at a time, exactly as when no concurrency is configured

#### Scenario: Concurrent page sessions share one whole-run deadline
- **WHEN** a run configured with several page workers reaches its producer timeout while page sessions are in flight
- **THEN** no further page session is launched, each in-flight session remains bounded by its own per-session timeout against the shared remaining budget, and no session is terminated early to divide the budget among workers

#### Scenario: Per-session timeout bounds one page, not the run
- **WHEN** one page's session exceeds the configured per-session timeout
- **THEN** that child process is terminated, that page is left unproduced, and the remaining planned pages are still attempted

#### Scenario: Per-step model and effort apply to that step only
- **WHEN** a split init runs with a model or effort configured for one step and the other steps unset
- **THEN** only that step's sessions spawn with the configured values — the map session for map, the planner and every area session for planning, the page sessions for page — while every other session keeps the run-wide model and effort

#### Scenario: A rate-limited page session aborts in-flight peers
- **WHEN** any page session reports a usage limit while other page sessions are in flight
- **THEN** the in-flight sessions are terminated, no further page session is launched, the overview session does not run, and the run reports `rate_limited` with partial work preserved and the reset time that session reported

#### Scenario: A rate-limited abort resumes cleanly
- **WHEN** a later run resumes after a rate-limited abort that terminated in-flight page sessions
- **THEN** only pages that are neither present nor conformant are produced again — a terminated worker's partial file is treated as unproduced and does not corrupt the resumed run

#### Scenario: The first failing page leads the failure report
- **WHEN** several page sessions fail in one run
- **THEN** the run's report carries the first failing session by launch order, and every failed page is still recorded individually in the run's notes

#### Scenario: Timeout kills the run
- **WHEN** a run exceeds the configured producer timeout
- **THEN** any running child process is terminated, no further sessions are launched, and the run is reported as timed out

### Requirement: Claude producer page plan
Before producing any page, the `claude` producer SHALL run a planning session that lays out the bundle's page set, and SHALL validate that plan before generation begins. A plan entry SHALL name the page's bundle-relative path, its frontmatter `type`, its title, a brief describing what the page must cover, and the source paths the planner attributes to it. The producer SHALL reject a plan that cannot be parsed, that names no page on an init run, or that names a reserved file name as a concept page, and SHALL report the run as failed without writing any page. On an update run the plan MAY additionally name pages to delete; an update plan naming no pages is a legitimate no-op. The planning session's guidance SHALL instruct a staged exploration of the repository before planning — mapping manifests, entry points and public surfaces, then tracing representative end-to-end control and data flow, then verifying boundaries and invariants against focused tests and neighbouring implementations — and SHALL instruct organizing the bundle around owned systems, runtime domains and cross-system workflows rather than mirroring the source tree. The planning guidance SHALL pin the page `type` to a closed, singular vocabulary: a page session copies the plan's `type` into its frontmatter verbatim and an existing page keeps its type on updates, so independently planned entries that spell one kind differently fossilize two kinds into the bundle.

#### Scenario: Plan precedes generation
- **WHEN** an init run starts for a repo with no bundle
- **THEN** a planning session runs first and no page session is launched before its plan has been validated

#### Scenario: Unparseable plan fails the run without writing pages
- **WHEN** the planning session produces output from which no plan can be parsed
- **THEN** the run is reported as failed and no concept page is written to the bundle

#### Scenario: Empty plan fails the run
- **WHEN** an init run's planning session produces a plan containing no pages
- **THEN** the run is reported as failed rather than producing an empty bundle

#### Scenario: A plan naming a reserved file is rejected
- **WHEN** a plan names `index.md` or `log.md` as a concept page to produce
- **THEN** the plan is rejected and the run is reported as failed

#### Scenario: Planner prompt instructs staged, system-oriented planning
- **WHEN** the planning session's prompt is generated
- **THEN** it includes guidance to map manifests, entry points and public surfaces, to trace representative end-to-end control and data flow, to verify boundaries and invariants against focused tests, and to organize the bundle around owned systems, runtime domains and cross-system workflows rather than mirroring the source tree

#### Scenario: Planning guidance pins a closed, singular type vocabulary
- **WHEN** the planning session's prompt is generated
- **THEN** it names the page kinds as a closed set in singular form and instructs against pluralized or invented kinds, because the page session copies the plan's `type` verbatim into frontmatter and an existing page keeps its type on updates

### Requirement: Checkpointed planning for large initial bundles

On an init run for a checkout whose documentable file count exceeds a configured threshold, the `claude` producer SHALL decompose
planning so that no single session's loss discards the whole plan: a **map
session** SHALL first produce an area map — a dot-file inside the bundle naming
each planned area and its scope —
seeded by a deterministic digest of the checkout (its documentable file tree and
per-directory sizes, derived from git at no model cost, excluding the
non-documentable kinds the map-ownership guidance defines); then one **area
session** per map area SHALL produce a plan part — a dot-file naming that area's
pages in the ordinary plan-entry shape. Areas SHALL be sized from the checkout's
documentable file count N — an area's scope SHALL cover at most min(5% of N, 1000)
files (the repository root's own files exempt: a flat pile the digest presents
as one group, which no coherent ownership boundary splits). The producer SHALL
validate the map against that sizing. An area whose scope covers more files than
the per-area maximum SHALL be split deterministically into parts before the map
is validated — each part named by the area's id plus a `part-<k>` suffix,
inheriting the area's title and scope, and covering at most the per-area maximum
— and the parts SHALL replace the area in the map that is validated and used.
The split SHALL proceed down the owned scope tree to the files themselves, so
every over-budget area has a split, and SHALL leave the repository root's own
files unsplit. The producer SHALL reject as invalid, after any such split, a map
whose area count falls outside half to double the count the sizing implies. Each
artifact SHALL be validated when
its session returns, and an artifact that is present and valid SHALL mean its
unit is done: a later run SHALL NOT re-run a session whose artifact already
exists and validates. When every map area has a valid part, the parts SHALL
merge deterministically into the plan file, which then satisfies the ordinary
plan requirements before any page session runs. The area sessions SHALL run in
map order, and each area session's directives SHALL name the page titles the
previously completed parts have already planned, so an area does not re-plan a
subject another area has already claimed; the listing is what makes the
cross-cutting ownership guidance checkable by each session against facts
rather than exhortation. The merge SHALL collapse entries that name the same
cross-cutting subject — independent area sessions otherwise plan it once per
area — where a collision is either titles differing only in case or
whitespace, or filenames whose normalized stem names a cross-cutting subject:
state management, constants or configuration, utilities or helpers, navigation
or routing, analytics or logging, error handling. A stem naming no
cross-cutting subject SHALL never trigger a fold, so per-stream pages sharing
a generic name — each stream's `overview.md`, each stream's own API
integration page — survive. The earliest
entry in map order SHALL survive, and every folded entry's source
paths and related pages SHALL be unioned into the surviving entry so no source
attribution or navigation intent is
lost; the merged plan SHALL NOT contain two entries that collide under these
rules. Each session SHALL be bounded by
the existing per-session timeout, and the run by the existing producer timeout.
A map or part recording a commit other than the commit being built SHALL be
discarded and re-planned, as a stamped plan already is. An unparseable or
invalid map or part SHALL be deleted and its unit treated as not done. An
invalid part SHALL NOT fail the run on its own — the remaining areas are still
attempted and the run reports incomplete work. A map session that ends without
completing but leaves a usable map SHALL be reported as leaving resumable work,
so the map is preserved and the next run re-validates it instead of remapping.
At or below the threshold, planning SHALL remain a
single session as specified elsewhere.

#### Scenario: Large init splits planning
- **WHEN** an init run starts for a repo whose documentable file count exceeds the configured threshold
- **THEN** planning runs as one map session followed by one session per mapped area, and no single session is asked to plan the whole repository

#### Scenario: Small init keeps single-session planning
- **WHEN** an init run starts for a repo at or below the configured threshold
- **THEN** planning runs as one planning session exactly as when no threshold is configured

#### Scenario: The map session is seeded by a digest of the documentable files
- **WHEN** the map session's prompt is generated
- **THEN** it includes a digest of the checkout's documentable file tree and per-directory sizes derived from git, produced without any model call, and the map is told that the digest lists every file the map may own

#### Scenario: Non-documentable files are omitted from the digest
- **WHEN** a checkout's tracked files include media or binary assets, lockfiles, string or localization catalogs, files under generated dependency directories, or animation bundles
- **THEN** the digest names only the remaining documentable files, states the documentable count, and reports how many tracked files were excluded and as what kind

#### Scenario: Areas are sized from the documentable file count
- **WHEN** the map session's prompt is generated for a checkout with N documentable files
- **THEN** it directs the map to size each area's scope at no more than min(5% of N, 1000) files, with the repository root's own files exempt; an area left over that maximum is split into parts as specified below, and an off-count map is rejected as specified below

#### Scenario: The root's own files are exempt from the area budget
- **WHEN** a map claims the repository root's own files as one area's scope and that file count exceeds the sizing rule's per-area maximum
- **THEN** the map is not rejected on that account, while the maximum still applies to every area whose scope lies below the root

#### Scenario: An over-budget area is split into parts, not rejected
- **WHEN** a map area's scope covers more files than the sizing rule's per-area maximum
- **THEN** the area is split deterministically at validation time into parts, each part's scope at or under the maximum, and the parts replace the area in the map that is validated and used, rather than the whole map being rejected and replanned

#### Scenario: A split part keeps its origin area's identity
- **WHEN** an over-budget area is split into parts
- **THEN** each part is named with the area's id plus a `part-<k>` suffix and inherits the area's title and scope, so the sessions planning each part still recognize that they document one original area

#### Scenario: An over-budget area always has a split
- **WHEN** an over-budget area's scope cannot be cut at directory boundaries — a directory holding more files than the per-area maximum directly
- **THEN** the split descends to the files the area owns and partitions them into parts at or under the maximum, so the area is not rejected on the budget account, and the repository root's own files are never part of a split

#### Scenario: An off-sizing map is rejected
- **WHEN** the map session returns a map whose area count is outside half to double the count the sizing rule implies for the checkout
- **THEN** the map is deleted and its unit re-planned, exactly as an unparseable map

#### Scenario: Completed planning units survive an interrupted run
- **WHEN** a run produces the map and some area parts and is then terminated before the remaining areas are planned
- **THEN** the map and completed parts are preserved in the work-in-progress area, and the next run plans only the areas still missing

#### Scenario: A moved target commit discards planning artifacts
- **WHEN** a run encounters a map or part recorded against a commit other than the one being built
- **THEN** that artifact is discarded and its unit is re-planned before merging

#### Scenario: An invalid part is discarded, not fatal
- **WHEN** an area session returns an artifact that cannot be parsed or names unusable page paths
- **THEN** that artifact is deleted, the area remains unplaned, the run continues with the remaining areas, and the run reports incomplete work rather than failing outright

#### Scenario: A failed map session preserves the map it wrote
- **WHEN** a map session times out or fails after writing a usable map
- **THEN** the run is reported as leaving resumable work, the map is preserved in the work-in-progress area, and the next run validates it rather than running a new map session

#### Scenario: A rate-limited area session ends the run
- **WHEN** an area session ends rate-limited
- **THEN** the run stops launching further sessions, is reported as rate-limited with its completed artifacts preserved, exactly as a rate-limited page session ends the page loop

#### Scenario: Merged plan precedes generation
- **WHEN** the last missing area part completes the map
- **THEN** the parts merge into the validated plan file and only then does page generation begin

#### Scenario: A title collision folds at merge
- **WHEN** two area parts name pages whose titles differ only in case or surrounding or internal whitespace
- **THEN** the merge keeps the first entry in map order, unions the later entry's source paths and related pages into it, and the merged plan names the subject once

#### Scenario: A shared cross-cutting stem folds at merge
- **WHEN** area parts name pages whose filenames share a normalized stem naming a cross-cutting subject — several areas each planning their own `state-management.md`
- **THEN** the merge keeps the first entry in map order, unions the later entries' source paths and related pages into it, and the subject is planned as one page

#### Scenario: A generic stem outside the subjects never folds
- **WHEN** two area parts name pages sharing a filename stem that names no cross-cutting subject — each stream's own `overview.md`, or each stream's own API integration page
- **THEN** both entries survive the merge

#### Scenario: The merged plan carries no collisions
- **WHEN** the merge writes the plan file
- **THEN** no two of its entries collide under either rule, and every folded entry's source paths and related pages are present on the surviving entry

#### Scenario: An area session sees the titles already planned
- **WHEN** an area session's directives are generated after one or more other areas' parts have completed
- **THEN** the directives name the page titles those parts planned, and the merge fold remains as the mechanical backstop for a session that plans an already-planned title anyway

### Requirement: Init plan page budget

An init plan — the plan produced by the single-session planner below the split
threshold, and the plan merged from area parts above it — SHALL NOT name more
pages than the checkout's page budget: `max(12, ceil(N / 100))` pages for N
documentable files, a fixed ratio rather than an absolute count, so the budget
scales from small checkouts to monorepos. The page-production entry the init
planner derives from the pages that actually shipped is not part of the plan
and is not counted. Planning guidance for init SHALL carry the same ratio as a
target and SHALL name the anti-pattern the budget exists for — planning one
page per screen, dialog, or directory leaf when those share a subject — so
sessions self-limit before validation; the guidance SHALL NOT instruct merging
pages that document distinct subjects.

When the merged plan exceeds the budget, the producer SHALL first reduce it by
deterministic repair, before the plan is validated: an entry group whose
members share `type` and whose source paths share a common parent directory
SHALL merge into one entry — the earliest in map order surviving, titled after
the common parent, its source paths and related pages the union of the group's
— and the pass SHALL repeat until the plan is within budget or no eligible
group remains. Repair SHALL never merge entries that differ in `type`, entries
owned by different map areas, or entries whose only similarity is a shared
cross-cutting stem (those folds already happened and their rules stand). A plan
still over budget after repair SHALL fail the run with a note naming the
budget, the post-repair page count, and the areas that could not merge — the
same outcome as an unparseable plan, recorded by the ordinary run-outcome path.

`bun run eval` SHALL report the evaluated bundle's plan granularity — planned
pages per documentable file — alongside its existing scores. The report is a
measurement surface: bundle acceptance SHALL NOT gate on plan granularity, and
no acceptance floor is added by this change.

#### Scenario: Budget scales with the checkout

- **WHEN** an init plan is produced for a checkout with N documentable files
- **THEN** the plan names at most max(12, ceil(N/100)) pages — e.g. 12 for
  N ≤ 1200, 140 for 14,000 — whatever the planning shape (single session or
  merged parts)

#### Scenario: Guidance carries the ratio and the anti-pattern

- **WHEN** the init planner's or an area session's prompt is generated
- **THEN** it directs the session to size the plan near one page per hundred
  documentable files in scope, and instructs against one-page-per-screen,
  -dialog, or -leaf planning where those pages share a subject

#### Scenario: Over-budget plan merges at the seams, deterministically

- **WHEN** the merged init plan names more pages than the budget
- **THEN** entries sharing `type` and a common source-path parent merge into
  one entry — earliest in map order surviving, titled after the common parent,
  source paths and related pages unioned — repeating until within budget or no
  eligible group remains, and the same plan input always yields the same merged
  plan

#### Scenario: Repair never crosses the seams

- **WHEN** the repair pass runs on an over-budget plan
- **THEN** entries of different `type`, entries from different map areas, and
  entries differing only by a cross-cutting subject stem are never merged, so
  the fold rules of checkpointed planning are not re-applied or weakened

#### Scenario: An irreducible plan fails the run with its numbers

- **WHEN** a plan remains over budget after no eligible group is left to merge
- **THEN** the run fails with a note naming the budget, the post-repair page
  count, and the areas that could not merge, and the ordinary plan-validation
  failure path handles it (no bundle written, last good bundle untouched)

#### Scenario: Eval reports plan granularity without gating

- **WHEN** `bun run eval` runs against a bundle
- **THEN** it reports planned pages per documentable file with its scores, and
  bundle acceptance passes or fails independently of that number

### Requirement: Claude producer map ownership guidance

The map phase's authoring guidance SHALL define what the area map owns. An area
SHALL be an overlapping scope, not a partition: the guidance SHALL permit — and
encourage — the same file to be claimed by more than one area, so exploration
of a shared component happens from each context that uses it, and SHALL NOT
demand that every file belong to exactly one area or that the areas' paths
partition the tree. Overlap SHALL govern what sessions may read, not what
pages may be planned: the guidance SHALL direct that a cross-cutting subject —
state management, constants or configuration, utilities or helpers, navigation
or routing, analytics or logging, error handling — is planned as at most one
page in the whole bundle, owned by the area whose paths host that code, and
that an area whose scope merely consumes such code plans no page of its own
for it. The map session's guidance SHALL say so, and SHALL direct the mapper to
record in each area's `scope` which cross-cutting subjects that area owns, so
every area session receives its ownership as part of the scope it plans from;
the area sessions' guidance
SHALL repeat the rule and SHALL name the titles already planned by the
completed parts: each area session SHALL be directed to plan only pages
specific to its area's own paths and to plan no page that mirrors a
cross-cutting subject for its slice, so the duplication the merge would
otherwise fold is not planned at all. The map SHALL own only files the digest
lists: files excluded from
the digest as non-documentable (media and binary assets, lockfiles, string and
localization catalogs, files under generated dependency directories, animation
bundles) need no owner and SHALL NOT be given an area of their own or claimed
through a `path` into an omitted subtree. The guidance SHALL direct the map to
cover every top-level code group the digest lists at least once, and to verify
the map before writing it: each area's own file total (summed from the digest's
per-directory counts) at or under the per-area budget, every digest group
reached, no area named for an inert subtree — because an area left over budget
is split by the run into mechanical `part-<k>` siblings along directory
boundaries, not along the flows the mapper would have chosen. The guidance
SHALL direct that an area be named for a
flow, module or platform silo, never for a file-kind directory (`-constants`,
`-utils`, `-hooks`, `-types`) on its own, and that the session's closing
summary describe what it wrote rather than assert coverage, which the run
verifies from the artifact, not the prose.

#### Scenario: Guidance permits overlapping areas
- **WHEN** the map phase's guidance is read
- **THEN** it states that a file may belong to more than one area and that shared code may be explored from each context that uses it

#### Scenario: Guidance does not demand a strict partition
- **WHEN** the map phase's guidance is read
- **THEN** it contains no requirement that every tracked file belong to exactly one area and no demand that the areas' paths together cover the whole tree

#### Scenario: Guidance assigns cross-cutting subjects to one area
- **WHEN** the map phase's guidance is read
- **THEN** it states that a cross-cutting subject — state management, constants or configuration, utilities or helpers, navigation or routing, analytics or logging, error handling — is planned as at most one page owned by the area whose paths host that code, and directs the mapper to record that ownership in the owning area's scope

#### Scenario: Area-session guidance forbids boilerplate mirrors
- **WHEN** an area session's directives are generated
- **THEN** they instruct the session to plan only pages specific to its area's own paths, to plan no page that mirrors a cross-cutting subject for its own slice, and to avoid every title the directives name as already planned

#### Scenario: Guidance refuses areas for omitted files
- **WHEN** the map phase's guidance is read
- **THEN** it states that files the digest omits as non-documentable need no owner and must not be given an area, and that no area path may reach into an omitted subtree

#### Scenario: Guidance names flows over file-kind directories
- **WHEN** the map phase's guidance is read
- **THEN** it instructs naming areas for flows, modules or platform silos, and not carving a feature into `-constants`, `-utils`, `-hooks` or `-types` stub areas

#### Scenario: Guidance requires a pre-write budget check
- **WHEN** the map phase's guidance is read
- **THEN** it instructs the mapper to total each area's files from the digest and split any area over the per-area budget before writing the map, because an over-budget area is otherwise split mechanically into `part-<k>` siblings by the run

#### Scenario: Guidance requires code-group reach
- **WHEN** the map phase's guidance is read
- **THEN** it instructs the mapper to confirm that every top-level code group the digest lists is reached by at least one area before writing

#### Scenario: Guidance forbids coverage claims in the summary
- **WHEN** the map phase's guidance is read
- **THEN** it instructs that the closing summary state what the map contains and not assert that it covers the repository
### Requirement: Plan-file checkpoint
The `claude` producer's page plan SHALL double as its run checkpoint: the planning session SHALL write the plan to a dot-file inside the bundle it is producing, and a page's completion SHALL be its presence in the bundle with parseable frontmatter and a non-empty `type` — no separate per-page state is persisted. Before any page session runs, the producer SHALL delete from the bundle every page the plan names and every page marked for deletion, and SHALL then record the commit being built in the plan file as the applied stamp, so a page present afterward was produced by this build. A run that finds a plan file in its bundle SHALL resume rather than replan: an unstamped plan is applied first (deletion, then stamp), a plan whose stamp matches the commit being built skips pages already present, and a plan whose stamp names a different commit SHALL be discarded and replanned. A run SHALL remove the plan file before reporting success, so a published bundle never carries one. The plan file SHALL NOT be visible as a wiki page: it SHALL NOT be indexed, served, or counted by bundle verification, grounding, or scoped-update checks.

#### Scenario: Completed pages survive an interrupted run
- **WHEN** a run produces several pages and is then terminated before finishing
- **THEN** the produced pages exist in the work-in-progress area alongside the plan file, and the resumed run launches no session for a page already present

#### Scenario: A resumed run produces only what is missing
- **WHEN** a run finds a plan file stamped with the commit being built
- **THEN** no planning session runs, no page already present is deleted or re-produced, and only the missing pages get a session

#### Scenario: Plan application is recorded before any page is produced
- **WHEN** a run finds an unstamped plan file — its own planning session just wrote one, or an earlier run was killed between planning and application
- **THEN** every page the plan names is deleted from the bundle and the plan file is stamped with the commit being built, all before any page session runs, so a stale pre-existing page is never mistaken for a produced one

#### Scenario: A moved target commit discards the plan
- **WHEN** a run finds a plan file stamped with a different commit than the one being built
- **THEN** the plan is discarded and a new planning session runs before any page is produced

#### Scenario: A successful run leaves no plan file behind
- **WHEN** a run reports success
- **THEN** the bundle contains no plan file, and the snapshot that promotion takes contains none either

#### Scenario: Plan file is invisible to the bundle's consumers
- **WHEN** a bundle carrying a plan file passes through verification, grounding, indexing, and the wiki viewer
- **THEN** the plan file is not verified as a page, not counted as a citation source, not indexed, and not served

### Requirement: Guaranteed overview page
Every `claude`-produced bundle SHALL carry a synthesized entry-point page at `overview.md` in the bundle root, distinct from the deterministically generated `index.md`. On an init run the producer SHALL produce it whether or not the plan named it, and SHALL NOT report a successful run without it present. On an update run the producer SHALL refuse to delete it, and SHALL produce it if it is absent from the existing bundle. It SHALL be produced last, after every other planned page, and its session SHALL be given the finished page list so it can route a reader to the bundle's major domains. On an update run that neither adds nor removes a page, the overview page SHALL be left unchanged, because it is an ordinary concept page subject to the scoped-update byte-identity check.

#### Scenario: Init always yields an overview page
- **WHEN** an init run completes successfully and the plan did not name an overview page
- **THEN** `overview.md` exists in the bundle root with frontmatter carrying a non-empty `type`

#### Scenario: A run missing its overview page is not successful
- **WHEN** every planned page is produced but the overview page is not
- **THEN** the run does not report success

#### Scenario: Update cannot delete the overview page
- **WHEN** an update run's plan names the overview page for deletion
- **THEN** the deletion does not occur and the page remains in the bundle

#### Scenario: Update restores a missing overview page
- **WHEN** an update run starts against an existing bundle with no overview page
- **THEN** the run produces one

#### Scenario: Overview is produced last with the finished page list
- **WHEN** a run produces several pages and then the overview page
- **THEN** the overview session runs after every other page session and its prompt names the pages that were produced

#### Scenario: An update that adds no page leaves the overview untouched
- **WHEN** an update run revises existing pages without adding or removing any page
- **THEN** the overview page is byte-identical to its pre-run content

### Requirement: Mermaid diagram authoring guidance
The `claude` producer's authoring skill SHALL instruct the model to embed a
Mermaid diagram in a page's body where the page describes component or module
relationships, a decision point with multiple outcomes, or a sequence of
interactions over time — using `flowchart TD` for the first two and
`sequenceDiagram` for the third — and SHALL instruct that every diagram be
followed by one sentence of prose describing what it shows. The skill SHALL
instruct that a page which is pure reference or already a single linear path
needs no diagram. The skill SHALL instruct that every node label be a quoted
string rather than a bare identifier, reducing the diagrams that fail parsing
and are degraded by bundle finalization.

#### Scenario: Skill instructs diagram authoring for structural and decision content
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance to embed a `flowchart TD` diagram for component
  or module relationships and for a decision point with multiple outcomes

#### Scenario: Skill instructs diagram authoring for sequential content
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance to embed a `sequenceDiagram` for a sequence of
  interactions over time

#### Scenario: Skill instructs a caption after every diagram
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance that every diagram is followed by one sentence
  of prose describing what it shows

#### Scenario: Skill instructs omitting diagrams from reference-only pages
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance to skip diagrams on pages that are pure
  reference or already a single linear path with nothing to branch or
  sequence

#### Scenario: Skill instructs quoted node labels
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance that Mermaid node labels are quoted strings,
  not bare identifiers

### Requirement: Claude producer authoring style guidance
The `claude` producer's authoring skill SHALL instruct the model to close every page with a related-pages section linking to other pages in the bundle relevant to it, each entry followed by a short description of what that page covers. The skill SHALL instruct bolding a term the first time it is formally introduced in a page's prose. The skill SHALL instruct writing a `tags` frontmatter field listing relevant kebab-case terms for the page. The skill SHALL instruct preferring a citation scoped to the specific lines that support a claim (`repo://path#Lstart-Lend`) over a whole-file citation whenever the model can identify the relevant lines. The skill SHALL instruct writing page prose plainly: stating facts and contrasts directly rather than through a contrastive-redefinition construction (e.g., "it's not X, it's Y"), and omitting hedging or filler phrasing.

#### Scenario: Skill instructs a closing related-pages section
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance to close a page with a section linking to related pages, each with a short description

#### Scenario: Skill instructs bold-on-first-mention
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance to bold a term the first time it is formally introduced in a page

#### Scenario: Skill instructs a tags field
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance to write a `tags` frontmatter field of relevant kebab-case terms

#### Scenario: Skill instructs preferring line-range citations
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance to cite the specific supporting lines (`#Lstart-Lend`) over a whole-file citation when the relevant lines can be identified

#### Scenario: Skill instructs plain, direct prose
- **WHEN** the `claude` producer's authoring prompt is generated
- **THEN** it includes guidance against contrastive-redefinition phrasing and hedging or filler constructions in page bodies

### Requirement: Claude producer page-depth guidance
The per-page session's guidance SHALL instruct the model to cover, where they apply to the page's subject: responsibilities, entry points, mechanisms and control flow, relationships to other units, state and lifecycle, invariants and failure modes, extension points, configuration and operational concerns, and the focused tests that pin the behaviour — and SHALL instruct against turning the page into a source-file inventory. The guidance SHALL instruct linking at the sentence that explains a relationship, naming what the relationship is with a relation verb, and SHALL instruct against padding a page with links to raise its connectivity or adding a reciprocal link reflexively; it SHALL instruct that a substantive page connect to at least two other pages or state why it is genuinely standalone. The guidance SHALL instruct writing the `description` field for retrieval, since it is matched by search tools, and SHALL instruct that a `description` describe the page's subject — the concrete unit, mechanism, or domain the page documents — as natural prose that stands alone as the page's one-line summary, because the field is displayed verbatim to readers in directory listings and retrieval results. The guidance SHALL instruct against describing the page's own role in the wiki bundle, such as naming the page an entry point to the wiki or telling a reader where to start. The guidance SHALL define concise as dense rather than short, and SHALL instruct against optimizing for page count or page length.

#### Scenario: Page prompt instructs a depth checklist and dense prose
- **WHEN** a per-page session's prompt is generated
- **THEN** it includes guidance to cover responsibilities, entry points, mechanisms and control flow, invariants and failure modes, extension points, configuration and focused tests, not to turn the page into a source-file inventory, and that concise means dense rather than short with page count and page length no targets to optimize

#### Scenario: Page prompt instructs relationship modeling and retrieval-oriented descriptions
- **WHEN** a per-page session's prompt is generated
- **THEN** it includes guidance to link at the sentence explaining the relationship using a relation verb, that a substantive page connects to at least two others or says why it is standalone, against padding links to raise connectivity or adding reciprocal links reflexively, and to write `description` for search retrieval

#### Scenario: Page prompt instructs subject-describing, non-navigational descriptions
- **WHEN** a per-page session's prompt is generated
- **THEN** it includes guidance that a `description` states the page's subject in natural prose readable as the page's one-line summary, and does not name the page's role in the wiki bundle (an entry point, a starting point) or direct the reader where to go next

### Requirement: Claude producer bundle finalization
The `claude` producer SHALL run a deterministic finalization pass over the bundle it wrote, after the agent completes and before the run reports its outcome, so these invariants do not depend on model behavior. The pass SHALL regenerate every directory `index.md` in the bundle from the concept pages actually present on disk, listing each page's frontmatter `title` (falling back to its filename when absent) and `description`, replacing any content the model wrote for that file. The pass SHALL validate every Mermaid fence in the bundle and SHALL degrade an invalid fence to a plain text fence carrying the original content, preceded by a comment recording the failure, so an unparseable diagram never reaches a reader. This requirement applies to the `claude` producer only — the `openwiki` producer already performs equivalent finalization internally before its bundle is written, so nothing here runs against an `openwiki`-produced bundle.

#### Scenario: Index regenerated from the pages actually written
- **WHEN** the `claude` producer's agent finishes writing concept pages, whether or not it wrote or updated `index.md` itself
- **THEN** every directory `index.md` in the bundle is regenerated to list exactly the concept pages and subdirectories present on disk, with each page's title and description read from its frontmatter

#### Scenario: Invalid Mermaid fence degraded to text
- **WHEN** the agent writes a page containing a Mermaid fence that fails to parse
- **THEN** the fence is rewritten to a plain text fence carrying the original content, preceded by a comment recording the failure, before the run reports its outcome

#### Scenario: Valid Mermaid fence left unchanged
- **WHEN** the agent writes a page containing a Mermaid fence that parses successfully
- **THEN** the fence is left byte-for-byte unchanged

#### Scenario: Finalization applies to the repair retry too
- **WHEN** a run is repaired by the one allowed repair retry
- **THEN** the finalization pass runs again against the retry's output before that attempt's outcome is reported

#### Scenario: Openwiki bundles are untouched
- **WHEN** the `openwiki` producer completes a run
- **THEN** no finalization pass from this requirement runs against its bundle

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
On an update run, a producer SHALL be given the set of source paths changed since the recorded `gitHead`, SHALL revise only the wiki pages affected by those changes, and SHALL preserve the existing bundle's conventions — a page outside the change set SHALL NOT have its `type` reassigned, and concept pages unrelated to the change set SHALL remain byte-identical. A genuinely new page introduced by the change set MAY carry a `type` not previously in use. Structural files that legitimately track other pages (directory indexes and changelogs) SHALL be exempt from the byte-identity check, which governs authored content only.

Whether a page is affected SHALL be judged from the citations it carried **before** the run as well as those it carries after. A page removed because the source file it documented was deleted has no post-run citations at all, and a page that swapped one citation for another would otherwise look untouchable; in both cases the pre-run citations are what justify the edit. A deletion the change set does not justify SHALL still be rejected.

The ratio of bundle change to source change SHALL be measured on every update and recorded. It SHALL reject the run only when an operator has configured a ceiling; the shipped default measures without gating, because the ratio is large by construction — a bundle has far fewer pages than the repo has files, so one page revised for one changed file out of five hundred already measures about 25x, and an uncalibrated ceiling would reject ordinary updates.

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

#### Scenario: A page deleted with its source is in scope
- **WHEN** an update run's change set includes a deleted source file, and the producer deletes the page that cited it
- **THEN** the deletion is accepted rather than reported as touching a page outside the change set

#### Scenario: An unjustified deletion is still out of scope
- **WHEN** an update run deletes a page whose only citations are to source files the change set did not touch
- **THEN** the run is reported as a scope failure and the last verified bundle is restored

#### Scenario: Churn is measured without a ceiling
- **WHEN** an update run completes and no churn ceiling is configured
- **THEN** the ratio of bundle change to source change is computed and recorded, and the run is not rejected on account of it

#### Scenario: Disproportionate rewrite rejected once a ceiling is set
- **WHEN** an update run rewrites a share of the bundle exceeding the configured ceiling as a multiple of the share of source files changed
- **THEN** the run is reported as a verification failure and the last verified bundle is restored

### Requirement: Bundle grounding verification
After each producer run, the system SHALL verify that source paths cited by wiki pages resolve in the checkout at the indexed commit, and SHALL compute the resolved fraction as the bundle's grounding score. A run whose grounding score falls below a configured floor SHALL be treated as a verification failure. Because a bundle that cites nothing trivially resolves everything it cites, the system SHALL also require a minimum citation density and SHALL treat a bundle below it as a verification failure regardless of its resolved fraction. The score SHALL be recorded for the repo so grounding regressions are observable over time. When a citation's `resource` carries a `#Lstart-Lend` line-range fragment, the system SHALL additionally check that range against the cited file's actual line count; a fragment whose start or end line falls outside the file SHALL be counted as unresolved for that citation, the same as a path that does not exist. A cited path that is a symbolic link, or whose physical location after resolving filesystem aliases falls outside the checkout or differs from the path named, SHALL be counted as unresolved and SHALL NOT be read, so a repository cannot direct citation resolution at a file outside its own checkout.

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

#### Scenario: Out-of-range line fragment counted as unresolved
- **WHEN** a page cites `repo://path#Lstart-Lend` and the file at `path` exists but has fewer lines than `Lend`
- **THEN** that citation is counted as unresolved in the grounding score, the same as a citation to a path that does not exist

#### Scenario: Symlinked citation counted as unresolved and never read
- **WHEN** a page cites a path inside the checkout that is a symbolic link to a file elsewhere on the host
- **THEN** that citation is counted as unresolved, the link target is not read, and the rest of the bundle is still scored

#### Scenario: A regular file reached through an aliased parent is not trusted
- **WHEN** a cited path resolves to a physical location outside the checkout's real root
- **THEN** that citation is counted as unresolved rather than resolved against the file it points at

### Requirement: Bundle link resolution scoring
After each producer run, the system SHALL check every in-body cross-page link — a Markdown link whose target ends in `.md` — against the bundle's own pages, reusing the same resolution rules the indexer already applies, and SHALL compute the resolved fraction as the bundle's link score. This check SHALL be applied identically regardless of which producer wrote the bundle. A run whose link score falls below a configured floor SHALL be treated as a verification failure. The shipped default SHALL measure without gating, matching the grounding, coverage, and churn floors, because link health needs the same operator-calibrated baseline before it is safe to enforce.

#### Scenario: Resolvable links accepted and scored
- **WHEN** a run produces pages whose in-body cross-page links all resolve to pages that exist in the bundle
- **THEN** the bundle passes this check and a link score of 1 is recorded

#### Scenario: Below-floor link score rejected once a ceiling is set
- **WHEN** an operator has configured a link-score floor and a run's resolved fraction falls below it
- **THEN** the run is reported as a verification failure and the last verified bundle is restored

#### Scenario: Unresolved links measured without gating by default
- **WHEN** no link-score floor is configured and a run produces a page with a link that does not resolve
- **THEN** the link score reflects the unresolved link but the run is not rejected on account of it

#### Scenario: Non-page link targets are not evaluated
- **WHEN** a page contains a Markdown link whose target does not end in `.md` (an external URL or a non-`.md` repository path)
- **THEN** that link is not counted in the link score

#### Scenario: Scoring is producer-independent
- **WHEN** the same bundle content, including the same unresolved link, is produced by either producer
- **THEN** the same link score is reported

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
Production SHALL be resumable so that work lost to an exhausted budget is not
repeated. A run SHALL produce into a work-in-progress area outside the published
bundle, and the published bundle SHALL be replaced only when a complete
work-in-progress bundle passes acceptance, as a single atomic promotion. A
work-in-progress area SHALL record the target commit and the producer that
created it. The recorded commit SHALL be the commit the run was *building* — the
checkout's head — and never the commit the existing bundle was generated from;
pinning the latter would hand the resumed run an empty change set. Preservation
SHALL therefore not depend on there being a previous bundle: an interrupted
**first** build has no such commit at all, and is the case this area exists for.
Resumable work SHALL include planning artifacts — a usable unapplied plan, or a
map with its completed parts — not only produced pages. When a run ends without
completing — because its usage limit was exhausted, because it ran out of time
or failed with planning or page work still incomplete, or because a producer
reported it left resumable work — the work-in-progress area SHALL be preserved
and the next run for that repo SHALL continue from it rather than starting over.
A producer SHALL report whether the run it just ended left resumable work and
the units that run completed, and the system SHALL preserve the work-in-progress
area on that report without inspecting which producer made it. A
work-in-progress area whose recorded producer differs from the currently
selected one SHALL be discarded rather than resumed. The system SHALL bound
resume attempts by a configured maximum, but the counter SHALL advance only
when a run completes no unit: a run that validates a map or a plan part, a
merged plan, or produces at least one page resets the counter. On exhaustion —
reachable only by runs that make no forward progress — the system SHALL stop
retrying that repo, discard the work-in-progress area, and surface the repo as
needing attention.

#### Scenario: Exhausted budget preserves partial work
- **WHEN** a run ends as `rate_limited` after producing part of a bundle
- **THEN** the partial output is preserved in the work-in-progress area, pinned to the commit that run was building, and the published bundle and index are unchanged and still queryable

#### Scenario: An interrupted first build is preserved too
- **WHEN** a repo's initial run ends as `rate_limited`, so there is no previous bundle and no anchor commit
- **THEN** the partial output is still preserved and pinned to the commit being built, and nothing partial is published or served

#### Scenario: A run that runs out of time preserves partial work
- **WHEN** a run reaches its producer timeout having completed some pages but not all
- **THEN** the completed pages are preserved in the work-in-progress area pinned to the commit being built, the run is reported as a failure, and the published bundle and index remain queryable

#### Scenario: A failed planning session preserves the plan it wrote
- **WHEN** a planning session times out or fails after writing a usable unapplied plan
- **THEN** the run is reported as leaving resumable work, the plan is preserved in the work-in-progress area, and the next run continues from that plan without a new planning session

#### Scenario: A failed map session preserves the map it wrote
- **WHEN** a split-planning run's map session times out or fails after writing a usable map
- **THEN** the map is preserved in the work-in-progress area exactly as a written plan is, and the next run resumes from it

#### Scenario: A run that leaves no resumable work preserves nothing
- **WHEN** a run fails before producing anything resumable, such as a spawn error or a planning session that died before writing any plan
- **THEN** no work-in-progress area is created and the resume attempt count is unchanged

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
- **WHEN** a repo reaches the configured maximum resume attempts with no run having completed a unit
- **THEN** the accumulated work is discarded, that run is reported as a failure so the repo reads red, and no further resume is attempted against that pinned commit

#### Scenario: Forward progress resets the attempt counter
- **WHEN** a repo's next run completes planning or page units after earlier runs that completed none
- **THEN** the resume counter resets rather than advancing, and the build continues on subsequent runs

#### Scenario: A repo too large for one budget window converges or is surfaced
- **WHEN** a repo's runs repeatedly reach the producer timeout with work still unproduced
- **THEN** each run resumes from the previous run's completed planning artifacts and pages rather than restarting, across as many budget windows as it needs — completing units keeps the resume counter reset — and only a run sequence with no forward progress reaches exhaustion and is surfaced as needing attention

**Not implemented:** taking the repo out of the rotation. Because exhaustion discards the work-in-progress area, the next batch finds no partial work and starts a fresh build, which can be cut short and begin accumulating attempts again. Excluding the repo (`--no-wiki`), splitting it, or running it against an API key remains a manual decision.

### Requirement: Resumable page sessions

The `claude` producer SHALL give every page session an identity that outlives
the child process, so a session killed mid-flight can be continued instead of
restarted. When the installed CLI advertises session identity and resume, the
producer SHALL assign each page session a fresh identity and persist it in the
bundle's checkpoint before the child process starts, and SHALL pass that
identity to the CLI; when the CLI does not advertise them, the producer SHALL
spawn page sessions with no identity and behave exactly as before. On a later
run, a planned page that is not yet produced and carries a persisted identity
SHALL be continued by resuming that session with a continuation prompt, in
place of a fresh session; a resumed session SHALL be subject to the same pool
concurrency cap, the same shared whole-run deadline, the same per-session
timeout, and the same cancellation as a fresh one. A persisted identity SHALL
remain resumable across interruptions until the page is produced or its
session ends in a terminal failure: producing the page, or a session outcome
that is neither a completion nor an interruption — a rate limit, a timeout, or
a cancellation — SHALL drop the record, so the next attempt for that page
starts fresh. When a recorded identity cannot be resumed — the transcript is
gone or the CLI refuses it — the producer SHALL spawn a fresh session for that
page in the same run and replace the record with the new identity. The
overview page is a page session and is covered by this requirement like any
other.

#### Scenario: An interrupted page session is resumed, not restarted
- **WHEN** a run resumes a bundle whose checkpoint records an identity for a planned page that is still unproduced
- **THEN** that page's session is started by resuming the recorded session, not as a fresh one

#### Scenario: A session identity is persisted before its session starts
- **WHEN** a page session is spawned while the CLI advertises session identity
- **THEN** its identity is already written in the bundle's checkpoint before the child process starts

#### Scenario: Resume survives repeated interruptions
- **WHEN** a resumed session is interrupted again without producing its page
- **THEN** a later run resumes the same session again rather than starting fresh

#### Scenario: A produced or terminally failed page is not resumed
- **WHEN** a page session produces its page, or ends in a terminal failure that is not an interruption
- **THEN** its checkpoint record is dropped and a later attempt for that page starts a fresh session

#### Scenario: An unresumable session falls back to a fresh one
- **WHEN** the CLI cannot resume a recorded identity
- **THEN** a fresh session for that page runs in the same run and its identity replaces the recorded one

#### Scenario: A CLI without session identity degrades to fresh sessions
- **WHEN** the installed CLI does not advertise session identity and resume
- **THEN** no page session is given an identity or resumed, and the run proceeds exactly as when every session is fresh

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

### Requirement: Structure-seeded planning on init
On an init run, the `claude` producer SHALL seed every planning session with the
checkout's structure derived from git at no model cost, so that no planning
session has to enumerate what already exists. The structure handout SHALL
present the documentable file tree per directory, each directory carrying its
file count, its total size, and its files named largest-first up to a bounded
count. The map session SHALL receive the whole handout; the undecomposed
planner on an init run at or below the split threshold SHALL receive the whole
handout; each area session SHALL receive the handout's slice covering the paths
its area owns, in addition to the other-area context the area session already
gets. The planning guidance SHALL treat the handout as authoritative for what
exists, SHALL direct file reads only where the handout cannot answer — to learn
what a directory is, to ground a page's scope or brief, or to trace a flow — and
SHALL keep organizing pages around owned systems and workflows rather than
mirroring the tree. Update planning is not seeded: it is change-scoped, is given
`changedPaths` directly, and is unchanged by this requirement.

#### Scenario: The undecomposed init planner is seeded with the structure
- **WHEN** an init run at or below the split threshold generates the planner session's prompt
- **THEN** the prompt includes the checkout's structure handout — per-directory file counts, sizes, and files named largest-first — produced from git without any model call

#### Scenario: An area session is seeded with the structure it owns
- **WHEN** a split init run generates an area session's prompt
- **THEN** the prompt includes a structure-handout slice covering the paths that area owns — that subtree's directories with counts, sizes, and named files — and does not list the file structure of directories another area owns

#### Scenario: The handout names a directory's load-bearing files
- **WHEN** the structure handout for a directory with several files is rendered
- **THEN** the directory's entry names its largest files first, up to a bounded count, alongside its file count and total size

#### Scenario: The map session keeps the whole structure handout
- **WHEN** a split init run generates the map session's prompt
- **THEN** the prompt includes the whole structure handout for the checkout, exactly as when only the map session was seeded

#### Scenario: Planning guidance reads files only when the handout is not enough
- **WHEN** an init planning session's authoring guidance is generated
- **THEN** it states that the handout is authoritative for what exists, that file reads are for understanding what a directory is, grounding a page's scope or brief, or tracing a flow — never for rediscovering the tree — and that pages are organized around systems and workflows rather than mirroring the tree

#### Scenario: Update planning is not seeded
- **WHEN** an update run generates its planner session's prompt
- **THEN** the prompt contains no structure handout and is unchanged by this requirement

### Requirement: Planning sessions on init do not enumerate
On an init run, the `claude` producer SHALL launch the planning sessions — the
map session, each area session, and the undecomposed planner — without the
directory-enumeration tool in their tool allowlist, because the structure handout
is their enumeration channel. Their allowlist SHALL still include reading files,
searching file contents, and writing the session's artifact. Page sessions and
update-planning sessions SHALL keep the full read toolset including enumeration:
a page session authors one page from `sourcePaths` given to it, and update
planning works from `changedPaths`, so neither has a structure handout to plan
from.

#### Scenario: The map session spawns without enumeration
- **WHEN** a split init run spawns the map session
- **THEN** the session's tool allowlist includes reading files, searching file contents, and writing the map, and does not include the directory-enumeration tool

#### Scenario: An area session spawns without enumeration
- **WHEN** a split init run spawns an area session
- **THEN** the session's tool allowlist includes reading files, searching file contents, and writing its part, and does not include the directory-enumeration tool

#### Scenario: The undecomposed init planner spawns without enumeration
- **WHEN** an init run at or below the split threshold spawns the planner session
- **THEN** the session's tool allowlist includes reading files, searching file contents, and writing the plan, and does not include the directory-enumeration tool

#### Scenario: A page session keeps the full read toolset
- **WHEN** an init run spawns a page session
- **THEN** the session's tool allowlist includes the directory-enumeration tool alongside reading, editing, and writing, exactly as before this requirement

#### Scenario: Update planning keeps enumeration
- **WHEN** an update run spawns its planner session
- **THEN** the session's tool allowlist is unchanged by this requirement and still includes the directory-enumeration tool
