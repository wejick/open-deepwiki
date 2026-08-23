# Dashboard Specification

## Purpose

A barebone operations page served by the open-deepwiki HTTP server: one
self-contained HTML file with vanilla embedded JS that lets anyone on the LAN
(with the bearer token) manage repos, watch wiki-generation status, and
exercise the MCP tools — no CLI access required.

## ADDED Requirements

### Requirement: Dashboard page delivery
The server SHALL serve the dashboard as static assets from the same HTTP
server: `GET /` returns the HTML page and `GET /dashboard.js` returns its
vanilla JavaScript. No framework and no build step SHALL be required; CSS
SHALL be limited to what layout and readability require; neither file SHALL
reference external scripts, stylesheets, fonts, or images. The client logic
SHALL live in `dashboard.js` as importable functions so tests can execute it
without a browser.

#### Scenario: Page and script served locally
- **WHEN** a client requests `GET /` and `GET /dashboard.js`
- **THEN** both return 200, the HTML loads the script from the same origin, and neither file references external URLs for scripts, styles, fonts, or images

### Requirement: Manual refresh only
The dashboard SHALL load and re-load its data only on explicit user action
(initial load and a Refresh button). It SHALL NOT poll: no timers or
intervals SHALL trigger network requests.

#### Scenario: No automatic polling
- **WHEN** the dashboard page is loaded
- **THEN** the page's JavaScript contains no timer or interval that issues network requests

#### Scenario: Refresh button reloads data
- **WHEN** the user clicks Refresh
- **THEN** the dashboard re-fetches the server status and re-renders the repo table

### Requirement: Repo status table
The dashboard SHALL render one row per repository from `GET /status`,
showing: health indicator, wiki and source document counts, abbreviated
last-indexed sha, last run time with outcome and duration, token usage when
recorded, and the last error when present. A repo whose last run has a start
time but no finish time SHALL be rendered as currently running.

#### Scenario: Rows render from status
- **WHEN** the dashboard fetches a status summary containing two repos
- **THEN** both repos appear with their health, document counts, sha, and last-run details

#### Scenario: Running repo indicated
- **WHEN** a repo's last run has startedAt set and finishedAt null
- **THEN** its row renders as in progress

### Requirement: Repo management actions
The dashboard SHALL provide a single-field add form (git URL or local path)
submitting to `POST /api/repos`, and per-row Update and Remove actions
submitting to `POST /api/repos/:id/update` and `DELETE /api/repos/:id`.
Remove SHALL require an explicit confirmation before submitting. Add and
update SHALL NOT block the page waiting for the run; the user observes
progress via Refresh.

#### Scenario: Remove requires confirmation
- **WHEN** the user clicks Remove on a repo row
- **THEN** the dashboard asks for confirmation and only issues the delete request after the user confirms

#### Scenario: Add submits the source
- **WHEN** the user enters a git URL and clicks Add
- **THEN** the dashboard posts the source to the add endpoint and reports acceptance or the returned error

### Requirement: Instructions editing
The dashboard SHALL provide a per-row instructions action that expands a
textarea pre-filled from `GET /api/repos/:id/instructions`, saves via
`PUT /api/repos/:id/instructions`, and displays a notice that changes apply
on the next wiki run. Saving SHALL NOT trigger a run.

#### Scenario: Save persists without running
- **WHEN** the user edits instructions text and clicks Save
- **THEN** the dashboard issues only the save request — no update request is issued

### Requirement: Retrieval smoke test
The dashboard SHALL provide a per-row Test action that calls the `ask_repo`
MCP tool scoped to that repo (question: the repo's first concept term,
falling back to `"overview"`) and prints the outcome under the row: number
of hits and the top hit's path and score, or the tool's "no relevant
content" message verbatim.

#### Scenario: Test reports retrieval outcome
- **WHEN** the user clicks Test on a repo with indexed content
- **THEN** the dashboard issues an `ask_repo` tool call for that repo and prints the hit count plus the top hit's path and score

### Requirement: MCP playground
The dashboard SHALL list all server tools by calling `tools/list` over
`POST /mcp` JSON-RPC, generate an argument form from the selected tool's
`inputSchema`, submit `tools/call`, and render the raw JSON result (or the
error result) verbatim. Adding a tool on the server SHALL NOT require
dashboard changes.

#### Scenario: Tools listed from the server
- **WHEN** the playground loads
- **THEN** the selectable tool list is exactly what `tools/list` returned

#### Scenario: Call renders raw result
- **WHEN** the user fills the generated form and clicks Call
- **THEN** the dashboard issues the `tools/call` request and renders the raw response body

### Requirement: Bearer token field
The dashboard SHALL provide a token input persisted in localStorage and
SHALL attach its value as `Authorization: Bearer <token>` to every `/api/*`
and `/mcp` request it issues.

#### Scenario: Token attached and persisted
- **WHEN** the user enters a token
- **THEN** subsequent API and MCP requests carry the bearer header and the token survives a page reload
