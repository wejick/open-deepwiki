## ADDED Requirements

### Requirement: Wiki navigation sidebar
Every repository wiki page — `/wiki/<repoId>` and any path below it — SHALL
render a navigation sidebar containing the complete concept hierarchy of that
repository: every indexed wiki concept as a link to
`/wiki/<repoId>/<concept-id>` showing the concept's title, and every wiki
directory that contains concepts or an `index.md` as a link to its directory
listing. Entries SHALL be nested by directory depth. Within a directory,
entries SHALL follow the order in which that directory's `index.md` lists its
files and directories; concepts and directories the `index.md` does not list
SHALL still appear, after the listed entries. The sidebar SHALL mark the entry
for the page being viewed — a concept's own entry, or for a directory listing
that directory's entry — as current using `aria-current="page"`. The sidebar
SHALL identify the repository's indexed revision as `Last indexed: <date>
(<short revision>)`, linking the revision to the repository's forge commit page
when a web location is derivable and rendering it as plain text otherwise; a
repository that has never been indexed SHALL render the sidebar without
revision information. The `/wiki` repository directory listing SHALL NOT render
a sidebar.

#### Scenario: Tree nested and ordered by index.md
- **WHEN** a repository wiki page is rendered and a directory's `index.md` lists its files and subdirectories in a specific order
- **THEN** the sidebar shows those entries as links in that order, with the subdirectory's own entries nested under it

#### Scenario: Unlisted concept still listed
- **WHEN** an indexed concept is absent from its directory's `index.md`
- **THEN** the sidebar still shows that concept's entry, after the entries the `index.md` lists

#### Scenario: Current concept marked
- **WHEN** a leaf concept page is rendered
- **THEN** the sidebar entry for that concept carries `aria-current="page"`

#### Scenario: Current directory marked
- **WHEN** a wiki directory listing is rendered
- **THEN** the sidebar entry for that directory carries `aria-current="page"`

#### Scenario: Indexed revision linked
- **WHEN** the repository has a `lastIndexedSha` and a GitHub or GitLab source
- **THEN** the sidebar header shows the indexing date and a shortened revision linking to that revision's forge commit page

#### Scenario: Revision without a web location
- **WHEN** the repository has no indexed revision, or its source yields no forge web location
- **THEN** the sidebar renders without a revision link

#### Scenario: Repo root has a sidebar
- **WHEN** a request is made for `/wiki/<repoId>`
- **THEN** the rendered repository root listing includes the sidebar

#### Scenario: Repo directory listing has no sidebar
- **WHEN** a request is made for `/wiki`
- **THEN** the rendered repository directory listing contains no sidebar

### Requirement: On this page outline
Every rendered wiki page SHALL render an "On this page" outline listing the
page body's h1–h3 headings in document order as links to those headings'
in-page anchors, indented by heading level. Every h1–h3 heading in the rendered
content SHALL carry a stable `id` matching its outline link, and headings whose
text repeats SHALL receive distinct ids. A page whose body contains no h1–h3
heading SHALL NOT render the outline.

#### Scenario: Outline links to anchored headings
- **WHEN** a page body contains a heading
- **THEN** the outline contains a link to that heading's anchor and the rendered heading carries the matching `id`

#### Scenario: Duplicate headings get distinct ids
- **WHEN** a page body contains two headings with the same text
- **THEN** the rendered headings carry different `id`s and both outline links resolve to them

#### Scenario: Indented by heading level
- **WHEN** a page body contains headings at different levels
- **THEN** the outline shows deeper heading levels at greater indentation

#### Scenario: Page without headings
- **WHEN** a page body contains no h1–h3 heading
- **THEN** the rendered page contains no outline

### Requirement: Responsive wiki layout
The wiki layout SHALL place the navigation sidebar and the outline beside the
content on wide viewports and SHALL hide each rail on narrow viewports so the
content uses the remaining width. Collapsing SHALL be achieved with stylesheet
rules only; no client-side script SHALL toggle either rail. The breadcrumb
topbar SHALL remain visible at every viewport width.

#### Scenario: Rails rendered beside content
- **WHEN** any repository wiki page is rendered
- **THEN** the shell contains the sidebar, the content, and the outline as distinct regions

#### Scenario: Narrow viewports hide the rails
- **WHEN** the rendered stylesheet is inspected
- **THEN** each rail has a viewport-width rule that hides it below its breakpoint

#### Scenario: No client script for the rails
- **WHEN** a wiki page without a Mermaid diagram is rendered
- **THEN** the page contains no script that toggles the sidebar or outline
