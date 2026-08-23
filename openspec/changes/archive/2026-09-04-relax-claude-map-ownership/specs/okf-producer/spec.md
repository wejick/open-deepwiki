## MODIFIED Requirements

### Requirement: Checkpointed planning for large initial bundles
On an init run for a checkout whose documentable file count exceeds a configured
threshold, the `claude` producer SHALL decompose planning so that no single
session's loss discards the whole plan: a **map session** SHALL first produce an
area map — a dot-file inside the bundle naming each planned area and its scope —
seeded by a deterministic digest of the checkout (its documentable file tree and
per-directory sizes, derived from git at no model cost, excluding the
non-documentable kinds the map-ownership guidance defines); then one **area
session** per map area SHALL produce a plan part — a dot-file naming that area's
pages in the ordinary plan-entry shape. Areas SHALL be sized from the checkout's
documentable file count N — an area's scope SHALL cover at most min(5% of N, 100)
files (the repository root's own files exempt: a flat pile the digest presents
as one group, which no coherent ownership boundary splits) — and the producer
SHALL validate the map against that sizing, rejecting
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
- **THEN** it directs the map to size each area's scope at no more than min(5% of N, 100) files, with the repository root's own files exempt, and an over-budget or off-count map is rejected as specified below

#### Scenario: The root's own files are exempt from the area budget
- **WHEN** a map claims the repository root's own files as one area's scope and that file count exceeds the sizing rule's per-area maximum
- **THEN** the map is not rejected on that account, while the maximum still applies to every area whose scope lies below the root

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

## ADDED Requirements

### Requirement: Claude producer map ownership guidance
The map phase's authoring guidance SHALL define what the area map owns. An area
SHALL be an overlapping scope, not a partition: the guidance SHALL permit — and
encourage — the same file to be claimed by more than one area, so a shared
component is documented from each context that uses it, and SHALL NOT demand
that every file belong to exactly one area or that the areas' paths partition
the tree. The map SHALL own only files the digest lists: files excluded from
the digest as non-documentable (media and binary assets, lockfiles, string and
localization catalogs, files under generated dependency directories, animation
bundles) need no owner and SHALL NOT be given an area of their own or claimed
through a `path` into an omitted subtree. The guidance SHALL direct the map to
cover every top-level code group the digest lists at least once, and to verify
the map before writing it: each area's own file total (summed from the digest's
per-directory counts) at or under the per-area budget, every digest group
reached, no area named for an inert subtree — because an over-budget area
discards the whole map. The guidance SHALL direct that an area be named for a
flow, module or platform silo, never for a file-kind directory (`-constants`,
`-utils`, `-hooks`, `-types`) on its own, and that the session's closing
summary describe what it wrote rather than assert coverage, which the run
verifies from the artifact, not the prose.

#### Scenario: Guidance permits overlapping areas
- **WHEN** the map phase's guidance is read
- **THEN** it states that a file may belong to more than one area and that shared code is documented from each context that uses it

#### Scenario: Guidance does not demand a strict partition
- **WHEN** the map phase's guidance is read
- **THEN** it contains no requirement that every tracked file belong to exactly one area and no demand that the areas' paths together cover the whole tree

#### Scenario: Guidance refuses areas for omitted files
- **WHEN** the map phase's guidance is read
- **THEN** it states that files the digest omits as non-documentable need no owner and must not be given an area, and that no area path may reach into an omitted subtree

#### Scenario: Guidance names flows over file-kind directories
- **WHEN** the map phase's guidance is read
- **THEN** it instructs naming areas for flows, modules or platform silos, and not carving a feature into `-constants`, `-utils`, `-hooks` or `-types` stub areas

#### Scenario: Guidance requires a pre-write budget check
- **WHEN** the map phase's guidance is read
- **THEN** it instructs the mapper to total each area's files from the digest and split any area over the per-area budget before writing the map, because an over-budget area is rejected

#### Scenario: Guidance requires code-group reach
- **WHEN** the map phase's guidance is read
- **THEN** it instructs the mapper to confirm that every top-level code group the digest lists is reached by at least one area before writing

#### Scenario: Guidance forbids coverage claims in the summary
- **WHEN** the map phase's guidance is read
- **THEN** it instructs that the closing summary state what the map contains and not assert that it covers the repository
