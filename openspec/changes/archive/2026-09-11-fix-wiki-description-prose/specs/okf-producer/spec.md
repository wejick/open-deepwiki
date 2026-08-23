## MODIFIED Requirements

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
