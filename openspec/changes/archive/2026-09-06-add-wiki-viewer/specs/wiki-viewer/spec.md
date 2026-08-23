## Purpose

Serves the generated wiki bundles as browsable HTML pages over HTTP, so a
person can read a repo's wiki in a browser the way MCP clients already read
it as tool output.

## ADDED Requirements

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
as the page path within that repository's wiki.

#### Scenario: Repo root
- **WHEN** a request path exactly matches a registered repoId
- **THEN** the response renders that repository's top-level wiki listing

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
already applied to the admin API. The token SHALL be presentable via a
`/wiki?token=<token>` link, which SHALL establish a session that subsequent
`/wiki/*` requests in the same browser reuse without repeating the token.

#### Scenario: Token accepted via bootstrap link
- **WHEN** a request for `/wiki?token=<valid-token>` is made
- **THEN** the response establishes a session and subsequent `/wiki/*` requests from that browser succeed without a token in the URL or headers

#### Scenario: Missing session and token rejected
- **WHEN** a bearer token is configured, the server is bound beyond localhost, and a `/wiki/*` request arrives with neither a valid session nor a valid token
- **THEN** the response is 401

#### Scenario: Localhost bind exempt
- **WHEN** the server is bound to localhost
- **THEN** `/wiki/*` requests succeed without a token, matching the admin API's existing localhost exemption
