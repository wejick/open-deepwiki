## MODIFIED Requirements

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
bundles, and files matched by the merged exclude set) need no owner and SHALL
NOT be given an area of their own or claimed through a `path` into an omitted
subtree. The guidance SHALL direct the map to cover every top-level code group
the digest lists at least once — unless it proposes that group for exclusion —
and to verify the map before writing it: each area's own file total (summed
from the digest's per-directory counts) at or under the per-area budget, every
digest group reached or proposed for exclusion, no area named for an inert
subtree — because an area left over budget is split by the run into mechanical
`part-<k>` siblings along directory boundaries, not along the flows the mapper
would have chosen. The guidance SHALL direct that an area be named for a
flow, module or platform silo, never for a file-kind directory (`-constants`,
`-utils`, `-hooks`, `-types`) on its own, and that the session's closing
summary describe what it wrote rather than assert coverage, which the run
verifies from the artifact, not the prose.

The guidance SHALL also define the exclusion escape hatch from that reach rule.
When the mapper judges a digest group to be data payload rather than code —
catalogs, golden or fixture data, asset metadata, frame maps — and its files
are not code, documentation, or configuration, the guidance SHALL permit
proposing that group for exclusion in the map's `exclude` list instead of
giving it an area, and SHALL require each proposal to name one whole directory
and carry one line of evidence. The guidance SHALL forbid proposing a
directory that mixes such content with code a person would search for,
documentation, or configuration that changes behavior, SHALL forbid proposing
a tree the mapper is not certain about, and SHALL state that a proposal that
fails the run's deterministic check invalidates the map rather than being
debated — so proposing nothing is the safe default.

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
- **THEN** it states that files the digest omits as non-documentable — including files matched by the merged exclude set — need no owner and must not be given an area, and that no area path may reach into an omitted subtree

#### Scenario: Guidance names flows over file-kind directories
- **WHEN** the map phase's guidance is read
- **THEN** it instructs naming areas for flows, modules or platform silos, and not carving a feature into `-constants`, `-utils`, `-hooks` or `-types` stub areas

#### Scenario: Guidance requires a pre-write budget check
- **WHEN** the map phase's guidance is read
- **THEN** it instructs the mapper to total each area's files from the digest and split any area over the per-area budget before writing the map, because an over-budget area is otherwise split mechanically into `part-<k>` siblings by the run

#### Scenario: Guidance requires code-group reach
- **WHEN** the map phase's guidance is read
- **THEN** it instructs the mapper to confirm, before writing, that every top-level code group the digest lists is reached by at least one area or proposed for exclusion

#### Scenario: Guidance permits proposing inert data groups for exclusion
- **WHEN** the map phase's guidance is read
- **THEN** it states that a digest group the mapper judges to be data payload rather than code may be proposed in the map's `exclude` list instead of being given an area, naming one whole directory with one line of evidence

#### Scenario: Guidance forbids proposing mixed or uncertain trees
- **WHEN** the map phase's guidance is read
- **THEN** it states that a directory mixing data with code, documentation, or behavior-changing configuration must be covered and never proposed, that a proposal made in doubt invalidates the map rather than being debated, and that proposing nothing is the safe default

#### Scenario: Guidance forbids coverage claims in the summary
- **WHEN** the map phase's guidance is read
- **THEN** it instructs that the closing summary state what the map contains and not assert that it covers the repository

## ADDED Requirements

### Requirement: Claude producer planning honors the merged exclude set
On an init run, the `claude` producer SHALL compute the checkout's
documentable file set — the set its structure handouts list, that area sizing
counts, and that the map may own — as the tracked files minus the
non-documentable kinds and minus every file the merged exclude set matches,
where the merged exclude set is the configured global exclude globs combined
additively with the repo's registry `excludeGlobs`, exactly as indexing already
merges them. The orchestrator SHALL supply the producer the merged exclude set
for the run. Every planning handout the producer renders — the map digest, the
undecomposed planner's structure handout, and each area session's slice — SHALL
be computed from that narrowed set, and the documentable count the producer
reports SHALL be the narrowed count.

#### Scenario: Glob-excluded tracked files are not planned
- **WHEN** a repo's merged exclude set contains `dist/**` and the checkout tracks files under `dist/` that are documentable by kind
- **THEN** the digest and every structure handout omit those files and the area sizing counts only the remaining documentable files

#### Scenario: An area slice never names a glob-excluded file
- **WHEN** an area owns a path whose subtree contains both documentable files and files the merged exclude set matches
- **THEN** the area's structure slice lists only the documentable files, never the matched ones

### Requirement: Claude producer map exclusion gate
When the map artifact carries `exclude` proposals, the run SHALL evaluate every
proposal deterministically against the checkout before any proposal takes
effect, and the outcome SHALL be all-or-nothing for the map. A valid proposal
SHALL name one whole directory — repo-relative, not the repository root —
under which at least one tracked file is currently documentable (not
kind-excluded and not already matched by the merged exclude set, so the
exclusion changes the documentable set). A proposal SHALL pass only when no
tracked file under that directory is a code file, a documentation file, or a
configuration file, judged by deterministic extension and filename lists the
producer defines. A proposal that fails any check SHALL invalidate the map: the
map is deleted and re-planned, with a note naming the rejected proposal and the
reason, because the map covered nothing the rejected proposal excluded. When
every proposal passes, the run SHALL narrow the documentable set by the
accepted directory globs, strip the map — removing each area `path` that now
owns no documentable file and dropping an area left owning none — and
revalidate the stripped map (reach over the narrowed set, per-area budget,
area count) before any area session runs; the structure slices handed to area
sessions SHALL be rendered from the narrowed set. The accepted globs SHALL be
recorded on the map artifact and reported when the run completes successfully,
so the orchestrator can persist them to the repo's registry `excludeGlobs`. The
gate SHALL be a pure function of the checkout and the map's proposals: reusing
a saved map SHALL re-run the same gate on the saved proposals, and a proposal
that no longer passes on a reused map SHALL invalidate it for re-planning.

#### Scenario: A certifiable data group is accepted and applied
- **WHEN** the map proposes a directory whose tracked files are all data (e.g. a `*.xcassets` tree of `Contents.json` catalogs) with at least one currently documentable file and none that is code, documentation, or configuration
- **THEN** the proposal passes, the directory's files leave the documentable set for the rest of the run, and the accepted glob is reported for persistence

#### Scenario: A proposal matching code invalidates the map
- **WHEN** the map proposes a directory under which a tracked file is a code file
- **THEN** the proposal fails, the map is deleted and re-planned, and the re-run's notes name the rejected proposal and the reason

#### Scenario: A root or malformed proposal invalidates the map
- **WHEN** the map proposes the repository root or a non-directory, non-repo-relative path
- **THEN** the proposal fails and the map is deleted and re-planned as above

#### Scenario: A no-op proposal invalidates the map
- **WHEN** the map proposes a directory under which no tracked file is currently documentable
- **THEN** the proposal fails as a no-op and the map is deleted and re-planned as above

#### Scenario: The map is stripped before area planning
- **WHEN** accepted proposals narrow the documentable set and an area's paths then own no documentable file, or own fewer
- **THEN** the empty area is dropped, the remaining areas' paths are kept as pruned by the narrowed set, the stripped map is revalidated, and only then do the area sessions run

#### Scenario: Area slices are rendered from the narrowed set
- **WHEN** an area session's directives are generated after proposals were accepted
- **THEN** its structure slice is rendered from the documentable set narrowed by the accepted globs

#### Scenario: A resumed run re-gates a saved map
- **WHEN** a later run reuses a saved map that still carries its proposals
- **THEN** the same gate runs on those proposals against the current checkout before the map is used, and a proposal that no longer passes invalidates the map for re-planning
