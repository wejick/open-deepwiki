## ADDED Requirements

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
