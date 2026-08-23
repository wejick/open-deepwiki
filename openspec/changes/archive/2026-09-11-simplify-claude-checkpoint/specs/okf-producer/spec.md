## MODIFIED Requirements

### Requirement: Non-interactive Claude Code producer invocation
The `claude` producer SHALL invoke the `claude` CLI in non-interactive print mode against the managed clone, with stdout/stderr captured. A run SHALL be orchestrated as a sequence of child sessions rather than one session: a planning session that produces the page plan, one session per planned page, and a final session for the overview page. Each child session SHALL be bounded by a configurable per-session timeout, and the run as a whole SHALL be bounded by the existing configurable producer timeout, after which the orchestrator SHALL stop launching further sessions. Every session SHALL be constrained so the producer can only read the checkout and write the bundle: no shell execution, no network tools, and no access to paths outside the clone. Authoring guidance SHALL come from a repo-owned skill that carries the OKF v0.2 contract, so the prompt is versioned with the code rather than embedded in it; the guidance SHALL be composed as one contract shared by every session plus one phase-specific prompt per session kind.

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

### Requirement: Claude producer page plan
Before producing any page, the `claude` producer SHALL run a planning session that lays out the bundle's page set, and SHALL validate that plan before generation begins. A plan entry SHALL name a bundle-relative page path; every other entry field (`type`, `title`, `brief`, source paths, related pages) is authoring cargo the producer passes to the page's session without interpreting it. The producer SHALL reject a plan that cannot be parsed, that names no page on an init run, or that names a reserved file name as a concept page, and SHALL report the run as failed without writing any page. On an update run the plan MAY additionally name pages to delete; an update plan naming no pages is a legitimate no-op. The planning session's guidance SHALL instruct a staged exploration of the repository before planning — mapping manifests, entry points and public surfaces, then tracing representative end-to-end control and data flow, then verifying boundaries and invariants against focused tests and neighbouring implementations — and SHALL instruct organizing the bundle around owned systems, runtime domains and cross-system workflows rather than mirroring the source tree.

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

## REMOVED Requirements

### Requirement: Durable per-page checkpoint
**Reason**: The per-page `RunState` is a second copy of two facts that already exist — a page's completion is its presence in the bundle with parseable frontmatter (which the producer already checks), and the resume pin already lives in the work-in-progress metadata. The plan file doubles as the checkpoint instead.
**Migration**: `.odw-run.json` is superseded by `.odw-plan.json`; a stale `.odw-run.json` in a preserved work-in-progress area is ignored (the run replans) and can be deleted by hand.

## ADDED Requirements

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
