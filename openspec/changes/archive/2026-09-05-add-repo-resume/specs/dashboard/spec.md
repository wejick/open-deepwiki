## ADDED Requirements

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
