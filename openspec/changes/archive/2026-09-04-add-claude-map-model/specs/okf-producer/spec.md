# okf-producer spec delta

## MODIFIED Requirements

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
sizing implies. The map session SHALL run on the run's model unless a separate
map model is configured, in which case only the map session uses it — its
output is deterministically validated either way. Each artifact SHALL be validated when
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

#### Scenario: A separately configured model applies to the map session only
- **WHEN** a map model is configured and a split init runs
- **THEN** the map session is spawned with that model while every area session, page session, and repair session keeps the run's model; with no map model configured every session uses the run's model

#### Scenario: An off-sizing map is rejected
- **WHEN** the map session returns a map whose area count is outside half to double the count the sizing rule implies for the checkout
- **THEN** the map is deleted and its unit re-planned, exactly as an unparseable map
