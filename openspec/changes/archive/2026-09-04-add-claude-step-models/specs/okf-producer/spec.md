# okf-producer spec delta

## MODIFIED Requirements

### Requirement: Non-interactive Claude Code producer invocation
The `claude` producer SHALL invoke the `claude` CLI in non-interactive print mode against the managed clone, with stdout/stderr captured. A run SHALL be orchestrated as a sequence of child sessions rather than one session: a planning session that produces the page plan, one session per planned page, and a final session for the overview page. Each child session SHALL be bounded by a configurable per-session timeout, and the run as a whole SHALL be bounded by the existing configurable producer timeout, after which the orchestrator SHALL stop launching further sessions. Every session SHALL be constrained so the producer can only read the checkout and write the bundle: no shell execution, no network tools, and no access to paths outside the clone other than the scratch file the planning session writes its plan to. Authoring guidance SHALL come from a repo-owned skill that carries the OKF v0.2 contract, so the prompt is versioned with the code rather than embedded in it; the guidance SHALL be composed as one contract shared by every session plus one phase-specific prompt per session kind. Each step — map (the area-map session), planning (the undecomposed planner session and every area session), and page (each page session, the overview session, and a repair session) — SHALL run on the run's model and effort unless a model or effort is separately configured for that step; an unset step value means the run-wide value, and a configured one applies to that step's sessions only.

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

#### Scenario: Per-session timeout bounds one page, not the run
- **WHEN** one page's session exceeds the configured per-session timeout
- **THEN** that child process is terminated, that page is left unproduced, and the remaining planned pages are still attempted

#### Scenario: Per-step model and effort apply to that step only
- **WHEN** a split init runs with a model or effort configured for one step and the other steps unset
- **THEN** only that step's sessions spawn with the configured values — the map session for map, the planner and every area session for planning, the page sessions for page — while every other session keeps the run-wide model and effort

#### Scenario: Timeout kills the run
- **WHEN** a run exceeds the configured producer timeout
- **THEN** any running child process is terminated, no further sessions are launched, and the run is reported as timed out

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
