# wiki-viewer Specification

## Purpose
TBD - created by archiving change add-wiki-viewer. Update Purpose after archive.
## Requirements
### Requirement: Repo directory listing
`GET /wiki` SHALL list every repository in the registry, each linking to
that repository's wiki root.

#### Scenario: Repos listed with links
- **WHEN** a request for `/wiki` is made
- **THEN** the response lists every registered repoId, each as a link to `/wiki/<repoId>`

#### Scenario: No repos registered
- **WHEN** a request for `/wiki` is made and the registry is empty
- **THEN** the response renders the listing page with no repo entries, not an error

### Requirement: Wiki page routing
`GET /wiki/<repoId>/<path>` SHALL resolve `repoId` as the longest prefix of
the URL that matches a registered repository, and SHALL treat the remainder
as the page path within that repository's wiki. A request that exactly matches
a registered repoId (`/wiki/<repoId>`) SHALL render that repository's top-level
`overview` concept when one exists, and SHALL render the repository's top-level
wiki listing otherwise.

#### Scenario: Repo root renders overview
- **WHEN** a request path exactly matches a registered repoId and that repository's wiki has a top-level `overview` concept
- **THEN** the response renders that concept's page

#### Scenario: Repo root
- **WHEN** a request path exactly matches a registered repoId and that repository's wiki has no top-level `overview` concept
- **THEN** the response renders that repository's top-level wiki listing

#### Scenario: Repo root with an overview missing on disk
- **WHEN** a request path exactly matches a registered repoId, the index has a top-level `overview` concept, but its file is absent from the bundle
- **THEN** the response renders the top-level wiki listing instead of an error

#### Scenario: Leaf page
- **WHEN** a request path is a registered repoId followed by a path matching an existing wiki concept
- **THEN** the response renders that concept's page

#### Scenario: Directory page
- **WHEN** a request path is a registered repoId followed by a path matching an existing wiki directory that is not itself a concept
- **THEN** the response renders that directory's listing

#### Scenario: Unknown repo
- **WHEN** no registered repoId is a prefix of the request path
- **THEN** the response is 404

#### Scenario: Unknown page in a known repo
- **WHEN** the resolved repoId is registered but the remaining path matches neither a concept nor a directory in that repository's wiki
- **THEN** the response is 404

### Requirement: Rendered page content
A wiki page response SHALL render the concept's Markdown body as HTML,
including syntax-highlighted code blocks, and SHALL render Mermaid diagram
blocks as diagrams rather than as code.

#### Scenario: Code block highlighted
- **WHEN** a page's Markdown body contains a fenced code block with a language tag
- **THEN** the rendered HTML highlights that block's syntax

#### Scenario: Mermaid block rendered as a diagram
- **WHEN** a page's Markdown body contains a fenced `mermaid` block
- **THEN** the page displays it as a rendered diagram, not as literal text or a highlighted code block

### Requirement: Page sources rendered with forge links
A wiki concept page whose frontmatter `sources` lists `repo://` resources SHALL
render a Sources section identifying each citation by its repo-relative path
and line range. An entry SHALL link to the repository's forge web location at
the repo's indexed revision when the registry `source` and `lastIndexedSha`
yield one: GitHub as `https://<host>/<owner>/<repo>/blob/<sha>/<path>`, GitLab
as `https://<host>/<group-path>/-/blob/<sha>/<path>`, with fragment
`#L<start>-L<end>` on GitHub, `#L<start>-<end>` on GitLab, `#L<n>` for a single
line, and no fragment for a citation without a line range. An entry whose
repository is local, whose host is not recognized, or whose repo has no indexed
revision SHALL render as plain `path` (with `:start-end` when the citation
carries a range) text instead of an anchor. Sources that are not `repo://`
resources SHALL be omitted, and a page with no renderable sources SHALL NOT
show the section.

#### Scenario: GitLab citation linked
- **WHEN** a page cites `repo://src/auth.ts#L10-L20` and its repo's source is `git@gitlab.corp:team/repo.git` with indexed revision `abc1234`
- **THEN** the rendered page links that entry to `https://gitlab.corp/team/repo/-/blob/abc1234/src/auth.ts#L10-20`

#### Scenario: GitHub citation linked
- **WHEN** a page cites `repo://src/auth.ts#L10-L20` and its repo's source is `git@github.com:team/repo.git` with indexed revision `abc1234`
- **THEN** the rendered page links that entry to `https://github.com/team/repo/blob/abc1234/src/auth.ts#L10-L20`

#### Scenario: File citation without a line range
- **WHEN** a page cites `repo://README.md` with no fragment
- **THEN** the rendered link points at the file at the indexed revision and carries no line fragment

#### Scenario: Single-line citation
- **WHEN** a page cites `repo://src/auth.ts#L8`
- **THEN** the rendered link's fragment is `#L8`

#### Scenario: Unlinkable repository degrades to text
- **WHEN** a page cites `repo://src/auth.ts#L10-L20` but its repo's source is a local path, its host is neither GitHub nor GitLab, or the repo has no indexed revision
- **THEN** the entry renders as plain `src/auth.ts:10-20` text with no anchor

#### Scenario: Page without renderable sources
- **WHEN** a concept page has no `sources` frontmatter, or none of its sources are `repo://` resources
- **THEN** the rendered page contains no Sources section

### Requirement: Inline source citations linked
Inline code spans in a wiki concept page's body that name a repository file and
a line range (`path:start-end`, `path:start`, `path#Lstart-Lend`, or
`path#Lstart`) SHALL render as a link to that file's forge web location at the
repo's indexed revision when the named path exists in the page's checkout and a
web location is derivable. The link's fragment SHALL use the mention's own line
range, not the page's frontmatter `sources`: GitHub as `#L<start>-L<end>`,
GitLab as `#L<start>-<end>`, and `#L<n>` for a single line. A mention whose path
is missing from the checkout, whose repo has no derivable web location, that
carries no line range, or that sits inside a fenced code block SHALL remain
plain inline code.

#### Scenario: Inline GitLab mention linked
- **WHEN** a page body contains `` `src/auth.ts:10-20` ``, the file exists in the checkout, and the repo's source is `git@gitlab.corp:team/repo.git` with indexed revision `abc1234`
- **THEN** the rendered page contains a link to `https://gitlab.corp/team/repo/-/blob/abc1234/src/auth.ts#L10-20` wrapping `<code>src/auth.ts:10-20</code>`

#### Scenario: Inline GitHub mention linked
- **WHEN** a page body contains `` `src/auth.ts:10-20` `` and the repo's source is `git@github.com:team/repo.git` with indexed revision `abc1234`
- **THEN** the rendered link target is `https://github.com/team/repo/blob/abc1234/src/auth.ts#L10-L20`

#### Scenario: Single-line mention
- **WHEN** a page body contains `` `src/auth.ts:8` `` and the file exists in the checkout
- **THEN** the rendered link's fragment is `#L8`

#### Scenario: Hash-form mention linked
- **WHEN** a page body contains `` `goal.ts#L71-L86` `` and the file exists in the checkout
- **THEN** the rendered link's fragment is `#L71-L86` (and a single `` `goal.ts#L20` `` mention gets `#L20`)

#### Scenario: Missing file stays code
- **WHEN** a page body contains `` `src/missing.ts:1-2` `` and no such file exists in the checkout
- **THEN** the mention renders as plain `<code>src/missing.ts:1-2</code>` with no link

#### Scenario: Unlinkable repository stays code
- **WHEN** a page body contains `` `src/auth.ts:1-2` `` but the repo's source is a local path, its host is neither GitHub nor GitLab, or the repo has no indexed revision
- **THEN** the mention renders as plain inline code with no link

#### Scenario: Fenced code untouched
- **WHEN** a fenced code block contains `src/auth.ts:1-2`
- **THEN** the block renders unchanged with no link

#### Scenario: Identifier without a line range not matched
- **WHEN** a page body contains an inline code span such as `` `session.execution.succeeded` ``
- **THEN** it renders as plain inline code with no link

### Requirement: Cross-page link resolution
Markdown links between wiki concepts SHALL resolve to working `/wiki/...`
URLs in the rendered page, regardless of whether the source link is written
relative to the linking file or absolute from the bundle root.

#### Scenario: Relative link resolved
- **WHEN** a page's Markdown body links to another concept using a path relative to its own directory
- **THEN** the rendered link's `href` points to that concept's `/wiki/<repoId>/<path>` URL

#### Scenario: Bundle-root-absolute link resolved
- **WHEN** a page's Markdown body links to another concept using a path absolute from the bundle root
- **THEN** the rendered link's `href` points to that concept's `/wiki/<repoId>/<path>` URL

### Requirement: Breadcrumb navigation
Every wiki page SHALL show a breadcrumb naming the repository and each path
segment down to the current page. Every segment before the current page
SHALL link to that segment's own listing or page; the current page SHALL NOT
be a link.

#### Scenario: Breadcrumb on a leaf page
- **WHEN** a leaf concept page is rendered
- **THEN** the breadcrumb shows the repoId and each intermediate directory as links, and the current page's title as plain text

#### Scenario: Breadcrumb links to directory listings
- **WHEN** a breadcrumb directory segment is followed
- **THEN** the response renders that directory's listing

### Requirement: Wiki authentication
`/wiki/*` requests SHALL require the server's configured bearer token when
one is set and the server is bound beyond localhost, matching the exemption
already applied to the admin API. The token SHALL be presentable via
`?token=<token>` on any `/wiki/*` path — including deep links to a specific
repo or page — which SHALL establish a session that subsequent `/wiki/*`
requests in the same browser reuse without repeating the token; the response
SHALL redirect to the same path without the token in the URL.

#### Scenario: Token accepted via bootstrap link
- **WHEN** a request for `/wiki?token=<valid-token>` is made
- **THEN** the response establishes a session and subsequent `/wiki/*` requests from that browser succeed without a token in the URL or headers

#### Scenario: Deep link bootstrap sets session and redirects cleanly
- **WHEN** a request for `/wiki/<repoId>/<path>?token=<valid-token>` is made
- **THEN** the response establishes the same session and redirects to `/wiki/<repoId>/<path>` without the token in the URL

#### Scenario: Deep link with invalid token rejected
- **WHEN** a bearer token is configured, the server is bound beyond localhost, and a request for `/wiki/<repoId>?token=<wrong-token>` is made
- **THEN** the response is 401 and no session is established

#### Scenario: Missing session and token rejected
- **WHEN** a bearer token is configured, the server is bound beyond localhost, and a `/wiki/*` request arrives with neither a valid session nor a valid token
- **THEN** the response is 401

#### Scenario: Localhost bind exempt
- **WHEN** the server is bound to localhost
- **THEN** `/wiki/*` requests succeed without a token, matching the admin API's existing localhost exemption

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

#### Scenario: Root overview marked
- **WHEN** `/wiki/<repoId>` renders a top-level `overview` concept
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

