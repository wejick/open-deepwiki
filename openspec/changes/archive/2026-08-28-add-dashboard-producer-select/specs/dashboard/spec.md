## MODIFIED Requirements

### Requirement: Repo management actions
The dashboard SHALL provide an add form with a source field (git URL or local
path) and a producer selector, submitting to `POST /api/repos`, and per-row
Update and Remove actions submitting to `POST /api/repos/:id/update` and
`DELETE /api/repos/:id`. The producer selector SHALL require an explicit
choice among exactly the producer ids the server supports; it SHALL NOT offer
a default or no-override option, and the submitted request SHALL always carry
a `producer` value. On acceptance the dashboard SHALL report the assigned
repoId together with the producer the server says will run. Remove SHALL
require an explicit confirmation before submitting. Add and update SHALL NOT
block the page waiting for the run; the user observes progress via Refresh.

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

#### Scenario: Acceptance names the producer
- **WHEN** the add request is accepted
- **THEN** the reported result names the assigned repoId and the producer the server said will run
