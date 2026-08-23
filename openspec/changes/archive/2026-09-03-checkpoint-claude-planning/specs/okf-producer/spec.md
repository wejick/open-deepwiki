## ADDED Requirements

### Requirement: Checkpointed planning for large initial bundles
On an init run for a checkout whose tracked file count exceeds a configured
threshold, the `claude` producer SHALL decompose planning so that no single
session's loss discards the whole plan: a **map session** SHALL first produce an
area map — a dot-file inside the bundle naming each planned area and its scope —
seeded by a deterministic digest of the checkout (its tracked file tree and
per-directory sizes, derived from git at no model cost); then one **area
session** per map area SHALL produce a plan part — a dot-file naming that area's
pages in the ordinary plan-entry shape. Areas SHALL be sized from the checkout's
tracked file count N — an area's scope SHALL cover at most min(5% of N, 100)
files — and the producer SHALL validate the map against that sizing, rejecting
as invalid a map whose area count falls outside half to double the count the
sizing implies. Each artifact SHALL be validated when
its session returns, and an artifact that is present and valid SHALL mean its
unit is done: a later run SHALL NOT re-run a session whose artifact already
exists and validates. When every map area has a valid part, the parts SHALL
merge deterministically into the plan file, which then satisfies the ordinary
plan requirements before any page session runs. Each session SHALL be bounded by
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
- **WHEN** an init run starts for a repo whose tracked file count exceeds the configured threshold
- **THEN** planning runs as one map session followed by one session per mapped area, and no single session is asked to plan the whole repository

#### Scenario: Small init keeps single-session planning
- **WHEN** an init run starts for a repo at or below the configured threshold
- **THEN** planning runs as one planning session exactly as when no threshold is configured

#### Scenario: The map session is seeded by a deterministic digest
- **WHEN** the map session's prompt is generated
- **THEN** it includes a digest of the checkout's tracked file tree and per-directory sizes derived from git, produced without any model call

#### Scenario: Areas are sized from the tracked file count
- **WHEN** the map session's prompt is generated for a checkout with N tracked files
- **THEN** it directs the map to size each area's scope at no more than min(5% of N, 100) files

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

## MODIFIED Requirements

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
