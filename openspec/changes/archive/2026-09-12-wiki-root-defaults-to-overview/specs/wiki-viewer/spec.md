## MODIFIED Requirements

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
