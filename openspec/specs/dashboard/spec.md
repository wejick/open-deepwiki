# Dashboard Specification

## Purpose

TBD — synced from change add-dashboard (archived 2026-08-25).
## Requirements
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
showing: health indicator, wiki document count, source document count (each
in its own column), abbreviated last-indexed sha, last run time with outcome
and duration, token usage when recorded, and the last error when present. A
repo whose last run has a start time but no finish time SHALL be rendered
according to the status payload's run-state classification: `running` as
currently in progress, and `interrupted` with a distinct rendering that does
not present the repo as making progress. Last run and running-since times
SHALL render in the viewer's local time zone, not the raw UTC value the
server returns. A repo whose wiki document count is positive SHALL render
its repo name as a link to `/wiki/<repoId>`; a repo with zero wiki documents
SHALL render its repo name as plain text. When a token is present in the
header token input, the link SHALL carry it as a `?token=` query parameter;
when the token is typed after rows are rendered, the rendered links SHALL
carry it without requiring a refresh.

#### Scenario: Rows render from status
- **WHEN** the dashboard fetches a status summary containing two repos
- **THEN** both repos appear with their health, wiki document count, source document count, sha, and last-run details

#### Scenario: Running repo indicated
- **WHEN** a repo's last run has startedAt set and finishedAt null, classified `running`
- **THEN** its row renders as in progress

#### Scenario: Interrupted repo not shown as running
- **WHEN** a repo's status entry carries the `interrupted` run-state classification
- **THEN** its row renders as interrupted (with its recorded start time), distinguishable from the in-progress rendering

#### Scenario: Document counts render as separate columns
- **WHEN** a repo's status reports wiki and source document counts
- **THEN** the dashboard renders them as two distinct columns, not a single combined "wiki/src" ratio cell

#### Scenario: Last run time renders in local time zone
- **WHEN** the dashboard renders a repo's last run or running-since timestamp
- **THEN** the displayed time reflects the viewer's browser-local time zone rather than the raw UTC value returned by the server

#### Scenario: Classification missing renders as today
- **WHEN** a status entry predates the run-state classification field
- **THEN** its row renders from start/finish times exactly as before this change

#### Scenario: Repo with wiki links to its wiki
- **WHEN** a row's status reports a positive wiki document count
- **THEN** the repo name renders as an anchor to `/wiki/<repoId>` (carrying `?token=` when a token is present)

#### Scenario: Repo without wiki renders plain text
- **WHEN** a row's status reports zero wiki documents
- **THEN** the repo name renders as plain text with no anchor

#### Scenario: Token typed after render updates links
- **WHEN** rows are rendered before a token is typed into the header token input, and the user then enters a token
- **THEN** the rendered wiki links carry `?token=` without a refresh

### Requirement: Production progress column
The repo status table SHALL render each repo's production progress from the
status payload: a compact phase-and-count rendering (for example
`planning 3/8` or `pages 12/22`) together with the age of the last progress
beat, for every repo whose progress is present. An in-flight planning entry
marked undecomposed SHALL render as `below threshold` in place of a unit count.
A repo whose progress is null SHALL render exactly as today. The rendering
SHALL live in a pure exported helper unit-testable without a DOM, per the
dashboard's structure rule. The page SHALL NOT poll, stream, or otherwise
reload on a timer: progress is visible on manual refresh, consistent with the
manual-refresh-only delivery.

#### Scenario: Progress renders for a building repo
- **WHEN** the status payload carries phase `planning` at 3 of 8 units with a last beat for a repo
- **THEN** that repo's row shows the phase, the 3/8 count, and the age of the last beat

#### Scenario: Undecomposed planning renders below-threshold
- **WHEN** the status payload carries an in-flight planning entry marked undecomposed for a repo
- **THEN** that repo's row shows `below threshold` in place of a unit count

#### Scenario: Null progress renders as today
- **WHEN** a repo's status entry carries null progress
- **THEN** its row is unchanged from the table without this feature

#### Scenario: Rendering helper is testable without a DOM
- **WHEN** the progress rendering helper is imported by a test runner with no browser globals
- **THEN** it produces the rendered text from a progress value alone

### Requirement: Repo management actions
The dashboard SHALL provide an add form with a source field (git URL or local
path), a producer selector, and an optional excludes field (one glob per
line), submitting to `POST /api/repos`, and per-row Update and Remove actions
submitting to `POST /api/repos/:id/update` and `DELETE /api/repos/:id`. The
producer selector SHALL require an explicit choice among exactly the producer
ids the server supports; it SHALL NOT offer a default or no-override option,
and the submitted request SHALL always carry a `producer` value. The excludes
field SHALL be parsed into the request's `excludeGlobs` array as the trimmed
non-empty lines, deduplicated, preserving first-occurrence order; a blank
field SHALL submit no `excludeGlobs` value. On acceptance the dashboard SHALL
report the assigned repoId together with the producer the server says will
run. Remove SHALL require an explicit confirmation before submitting. Add and
update SHALL NOT block the page waiting for the run; the user observes
progress via Refresh.

#### Scenario: Remove requires confirmation
- **WHEN** the user clicks Remove on a repo row
- **THEN** the dashboard asks for confirmation and only issues the delete request after the user confirms

#### Scenario: Add submits the source
- **WHEN** the user enters a git URL and clicks Add
- **THEN** the dashboard posts the source to the add endpoint and reports acceptance or the returned error

#### Scenario: Selected producer always submitted explicitly
- **WHEN** the user selects a producer and clicks Add
- **THEN** the posted body carries that producer id alongside the source, for every producer the selector offers

#### Scenario: Selector offers exactly the supported producers, no default
- **WHEN** the add form's producer options are compared with the producer ids the server accepts
- **THEN** they match exactly with no additional default or empty option, so the form can offer no id the server would reject, omit none it would accept, and never submit an add request without a producer

#### Scenario: Entered globs are submitted
- **WHEN** the user enters `**/*.snap` and `**/*.a` on separate lines in the excludes field and clicks Add
- **THEN** the posted body carries `excludeGlobs: ["**/*.snap", "**/*.a"]` alongside the source and producer

#### Scenario: Blank excludes field submits no globs
- **WHEN** the user leaves the excludes field empty and clicks Add
- **THEN** the posted body carries no `excludeGlobs` value, and blank lines and surrounding whitespace in a non-empty field are dropped

#### Scenario: Acceptance names the producer
- **WHEN** the add request is accepted
- **THEN** the reported result names the assigned repoId and the producer the server said will run

### Requirement: Resume action
The dashboard SHALL render a per-row Resume action only for repos whose status
payload reports a build in progress (`build != null`), and none for the rest.
Clicking Resume SHALL submit `POST /api/repos/:id/resume` without blocking the
page — progress is observed via Refresh — and SHALL display the response: the
queued confirmation, or the returned error (including nothing-to-resume and
busy rejections) verbatim.

#### Scenario: Build in progress renders the action
- **WHEN** the dashboard renders a repo whose status entry reports a build with a pinned sha and attempt count
- **THEN** the row offers a Resume action

#### Scenario: Idle repo renders no resume action
- **WHEN** the dashboard renders a repo whose status entry reports no build
- **THEN** the row offers no Resume action

#### Scenario: Click queues a resume without blocking
- **WHEN** the user clicks Resume on a row with a build in progress
- **THEN** the dashboard posts to the resume endpoint, reports the queued response, and the page stays usable while the run proceeds in the background

#### Scenario: Rejection surfaced
- **WHEN** the resume endpoint rejects with 409
- **THEN** the dashboard displays the returned error message

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

### Requirement: Schedule editing
The dashboard SHALL provide a per-row Schedule action that expands an input
pre-filled from `GET /api/repos/:id/schedule`, saves via
`PUT /api/repos/:id/schedule`, and displays a notice that the change applies
immediately. Submitting an empty input SHALL send the override-clearing
request. The dashboard SHALL render each repo's schedule from `GET /status` in
its row — the override expression when set, a default marker when null — and
SHALL display the error returned for an invalid expression.

#### Scenario: Editor pre-filled from the server
- **WHEN** the user opens the Schedule action on a repo with a stored override
- **THEN** the input shows the value returned by the schedule endpoint

#### Scenario: Save issues only the schedule request
- **WHEN** the user edits the expression and clicks Save
- **THEN** the dashboard issues only `PUT /api/repos/:id/schedule` — no update request

#### Scenario: Empty input clears the override
- **WHEN** the user clears the input and clicks Save
- **THEN** the dashboard sends the clearing request and reports the saved result

#### Scenario: Row shows the effective schedule
- **WHEN** the dashboard renders a repo whose status reports a schedule override, and one whose status reports null
- **THEN** the first row shows the override expression and the second shows the default marker

#### Scenario: Invalid expression error surfaced
- **WHEN** the server rejects a save with 400
- **THEN** the dashboard displays the returned error message

