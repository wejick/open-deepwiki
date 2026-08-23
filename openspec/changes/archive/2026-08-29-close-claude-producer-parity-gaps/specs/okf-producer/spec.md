## MODIFIED Requirements

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

### Requirement: Bundle grounding verification
After each producer run, the system SHALL verify that source paths cited by wiki pages resolve in the checkout at the indexed commit, and SHALL compute the resolved fraction as the bundle's grounding score. A run whose grounding score falls below a configured floor SHALL be treated as a verification failure. Because a bundle that cites nothing trivially resolves everything it cites, the system SHALL also require a minimum citation density and SHALL treat a bundle below it as a verification failure regardless of its resolved fraction. The score SHALL be recorded for the repo so grounding regressions are observable over time. When a citation's `resource` carries a `#Lstart-Lend` line-range fragment, the system SHALL additionally check that range against the cited file's actual line count; a fragment whose start or end line falls outside the file SHALL be counted as unresolved for that citation, the same as a path that does not exist.

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

## ADDED Requirements

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
