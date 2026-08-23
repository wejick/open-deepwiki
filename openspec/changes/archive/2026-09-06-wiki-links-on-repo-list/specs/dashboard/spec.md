## MODIFIED Requirements

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
