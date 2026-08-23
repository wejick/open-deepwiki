## MODIFIED Requirements

### Requirement: Repo status table
The dashboard SHALL render one row per repository from `GET /status`,
showing: health indicator, wiki document count, source document count (each
in its own column), abbreviated last-indexed sha, last run time with outcome
and duration, token usage when recorded, and the last error when present. A
repo whose last run has a start time but no finish time SHALL be rendered as
currently running. Last run and running-since times SHALL render in the
viewer's local time zone, not the raw UTC value the server returns.

#### Scenario: Rows render from status
- **WHEN** the dashboard fetches a status summary containing two repos
- **THEN** both repos appear with their health, wiki document count, source document count, sha, and last-run details

#### Scenario: Running repo indicated
- **WHEN** a repo's last run has startedAt set and finishedAt null
- **THEN** its row renders as in progress

#### Scenario: Document counts render as separate columns
- **WHEN** a repo's status reports wiki and source document counts
- **THEN** the dashboard renders them as two distinct columns, not a single combined "wiki/src" ratio cell

#### Scenario: Last run time renders in local time zone
- **WHEN** the dashboard renders a repo's last run or running-since timestamp
- **THEN** the displayed time reflects the viewer's browser-local time zone rather than the raw UTC value returned by the server
