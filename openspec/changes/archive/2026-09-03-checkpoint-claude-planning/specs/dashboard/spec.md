## ADDED Requirements

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
