## MODIFIED Requirements

### Requirement: Non-interactive Claude Code producer invocation
The `claude` producer SHALL invoke the `claude` CLI in non-interactive print mode against the managed clone, with stdout/stderr captured. A run SHALL be orchestrated as a sequence of child sessions rather than one session: a planning session that produces the page plan, one session per planned page, and a final session for the overview page. Each child session SHALL be bounded by a configurable per-session timeout, and the run as a whole SHALL be bounded by the existing configurable producer timeout, after which the orchestrator SHALL stop launching further sessions. Every session SHALL be constrained so the producer can only read the checkout and write the bundle: no shell execution, no network tools, and no access to paths outside the clone other than the scratch file the planning session writes its plan to. Authoring guidance SHALL come from a repo-owned skill that carries the OKF v0.2 contract, so the prompt is versioned with the code rather than embedded in it; the guidance SHALL be composed as one contract shared by every session plus one phase-specific prompt per session kind.

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

#### Scenario: Timeout kills the run
- **WHEN** a run exceeds the configured producer timeout
- **THEN** any running child process is terminated, no further sessions are launched, and the run is reported as timed out

### Requirement: Resumable production across runs
Production SHALL be resumable so that work lost to an exhausted budget is not repeated. A run SHALL produce into a work-in-progress area outside the published bundle, and the published bundle SHALL be replaced only when a complete work-in-progress bundle passes acceptance, as a single atomic promotion. A work-in-progress area SHALL record the target commit and the producer that created it. The recorded commit SHALL be the commit the run was *building* — the checkout's head — and never the commit the existing bundle was generated from; pinning the latter would hand the resumed run an empty change set. Preservation SHALL therefore not depend on there being a previous bundle: an interrupted **first** build has no such commit at all, and is the case this area exists for. When a run ends without completing — whether because its usage limit was exhausted or because it ran out of time with pages still unproduced — the work-in-progress area SHALL be preserved and the next run for that repo SHALL continue from it rather than starting over. A producer SHALL report whether the run it just ended left resumable work, and the system SHALL preserve the work-in-progress area on that report without inspecting which producer made it. A work-in-progress area whose recorded producer differs from the currently selected one SHALL be discarded rather than resumed. The system SHALL bound resume attempts by a configured maximum; on exhaustion it SHALL stop retrying that repo, discard the work-in-progress area, and surface the repo as needing attention.

#### Scenario: Exhausted budget preserves partial work
- **WHEN** a run ends as `rate_limited` after producing part of a bundle
- **THEN** the partial output is preserved in the work-in-progress area, pinned to the commit that run was building, and the published bundle and index are unchanged and still queryable

#### Scenario: An interrupted first build is preserved too
- **WHEN** a repo's initial run ends as `rate_limited`, so there is no previous bundle and no anchor commit
- **THEN** the partial output is still preserved and pinned to the commit being built, and nothing partial is published or served

#### Scenario: A run that runs out of time preserves partial work
- **WHEN** a run reaches its producer timeout having completed some pages but not all
- **THEN** the completed pages are preserved in the work-in-progress area pinned to the commit being built, the run is reported as a failure, and the published bundle and index remain queryable

#### Scenario: A run that leaves no resumable work preserves nothing
- **WHEN** a run fails before producing anything resumable, such as a spawn error
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
- **WHEN** a repo reaches the configured maximum resume attempts without completing
- **THEN** the accumulated work is discarded, that run is reported as a failure so the repo reads red, and no further resume is attempted against that pinned commit

#### Scenario: A repo too large for one budget window converges or is surfaced
- **WHEN** a repo's runs repeatedly reach the producer timeout with pages still unproduced
- **THEN** each run resumes from the previous run's completed pages rather than restarting, and once the configured maximum resume attempts is reached the repo is surfaced as needing attention

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

## ADDED Requirements

### Requirement: Claude producer page plan
Before producing any page, the `claude` producer SHALL run a planning session that lays out the bundle's page set, and SHALL validate that plan before generation begins. A plan entry SHALL name the page's bundle-relative path, its frontmatter `type`, its title, a brief describing what the page must cover, and the source paths the planner attributes to it. The producer SHALL reject a plan that cannot be parsed, that is empty, or that names a reserved file name as a concept page, and SHALL report the run as failed without writing any page. On an update run the plan MAY additionally name pages to delete. The planning session's guidance SHALL instruct a staged exploration of the repository before planning — mapping manifests, entry points and public surfaces, then tracing representative end-to-end control and data flow, then verifying boundaries and invariants against focused tests and neighbouring implementations — and SHALL instruct organizing the bundle around owned systems, runtime domains and cross-system workflows rather than mirroring the source tree.

#### Scenario: Plan precedes generation
- **WHEN** an init run starts for a repo with no bundle
- **THEN** a planning session runs first and no page session is launched before its plan has been validated

#### Scenario: Unparseable plan fails the run without writing pages
- **WHEN** the planning session produces output from which no plan can be parsed
- **THEN** the run is reported as failed and no concept page is written to the bundle

#### Scenario: Empty plan fails the run
- **WHEN** the planning session produces a plan containing no pages
- **THEN** the run is reported as failed rather than producing an empty bundle

#### Scenario: A plan naming a reserved file is rejected
- **WHEN** a plan names `index.md` or `log.md` as a concept page to produce
- **THEN** the plan is rejected and the run is reported as failed

#### Scenario: Planner prompt instructs staged, system-oriented planning
- **WHEN** the planning session's prompt is generated
- **THEN** it includes guidance to map manifests, entry points and public surfaces, to trace representative end-to-end control and data flow, to verify boundaries and invariants against focused tests, and to organize the bundle around owned systems, runtime domains and cross-system workflows rather than mirroring the source tree

### Requirement: Durable per-page checkpoint
The `claude` producer SHALL persist per-page job state durably within the bundle it is producing, recording the run's mode, the commit it is building, the validated plan, and each page's completion state. It SHALL persist that state after every transition, so state survives the child process being killed. On a later run the producer SHALL read that state and produce only the pages not yet complete, leaving completed pages untouched. When the recorded commit differs from the commit the current run is building, or the recorded mode differs from the current mode, the producer SHALL discard the plan and plan again rather than generating against stale context. The checkpoint SHALL NOT be visible as a wiki page: it SHALL NOT be indexed, served, or counted by bundle verification, grounding, or scoped-update checks.

#### Scenario: Completed pages survive an interrupted run
- **WHEN** a run produces several pages and is then terminated before finishing
- **THEN** the checkpoint records those pages as complete and they exist in the work-in-progress area

#### Scenario: A resumed run produces only what is missing
- **WHEN** a run resumes against a checkpoint with some pages complete
- **THEN** no session is launched for a completed page and only the remaining pages are produced

#### Scenario: A moved target commit discards the plan
- **WHEN** a run resumes against a checkpoint whose recorded commit differs from the commit now being built
- **THEN** the plan is discarded and a new planning session runs before any page is produced

#### Scenario: Checkpoint is invisible to the bundle's consumers
- **WHEN** a bundle carrying a checkpoint passes through verification, grounding, indexing, and the wiki viewer
- **THEN** the checkpoint is not verified as a page, not counted as a citation source, not indexed, and not served

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

### Requirement: Claude producer page-depth guidance
The per-page session's guidance SHALL instruct the model to cover, where they apply to the page's subject: responsibilities, entry points, mechanisms and control flow, relationships to other units, state and lifecycle, invariants and failure modes, extension points, configuration and operational concerns, and the focused tests that pin the behaviour — and SHALL instruct against turning the page into a source-file inventory. The guidance SHALL instruct linking at the sentence that explains a relationship, naming what the relationship is with a relation verb, and SHALL instruct against padding a page with links to raise its connectivity or adding a reciprocal link reflexively; it SHALL instruct that a substantive page connect to at least two other pages or state why it is genuinely standalone. The guidance SHALL instruct writing the `description` field for retrieval, since it is matched by search tools. The guidance SHALL define concise as dense rather than short, and SHALL instruct against optimizing for page count or page length.

#### Scenario: Page prompt instructs a depth checklist and dense prose
- **WHEN** a per-page session's prompt is generated
- **THEN** it includes guidance to cover responsibilities, entry points, mechanisms and control flow, invariants and failure modes, extension points, configuration and focused tests, not to turn the page into a source-file inventory, and that concise means dense rather than short with page count and page length no targets to optimize

#### Scenario: Page prompt instructs relationship modeling and retrieval-oriented descriptions
- **WHEN** a per-page session's prompt is generated
- **THEN** it includes guidance to link at the sentence explaining the relationship using a relation verb, that a substantive page connects to at least two others or says why it is standalone, against padding links to raise connectivity or adding reciprocal links reflexively, and to write `description` for search retrieval
