# okf-producer delta

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
