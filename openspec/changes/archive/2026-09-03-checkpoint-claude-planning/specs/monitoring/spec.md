## ADDED Requirements

### Requirement: Production progress in status
`/status` SHALL carry a per-repo production-progress field so an operator can
see where an in-flight or preserved build stands. Progress SHALL be computed at
read time from durable production artifacts — never stored — by counting the
validated plan's units against the staged bundle: during planning of a
decomposed build, phase `planning` with the map's areas as the total and
present valid parts as done; during page generation, phase `pages` with the
validated plan's pages as the total and present conformant pages as done. Each
entry SHALL carry the time of the newest contributing artifact as the last
progress beat, and whether the build's planning is decomposed. When a run is
not in flight, the same read SHALL fall back to the work-in-progress area, so a
multi-night build stays legible between runs. A build whose planning is a
single undecomposed session and is in flight SHALL report the planning phase
with an explicit undecomposed marker and no unit counts — distinct from null.
The field SHALL be null only when no legible artifact exists, such as an idle
repo. A read racing the producer's writes SHALL yield null rather than an
error. Progress SHALL NOT change health classification.

#### Scenario: Decomposed planning reports area progress
- **WHEN** a split-planning build is in flight with 3 of 8 area parts present and valid
- **THEN** `/status` reports that repo's progress as phase `planning`, 3 of 8 units, with the newest part's time as the last beat

#### Scenario: Page generation reports page progress
- **WHEN** generation is in flight against a validated plan of 22 pages with 12 present and conformant
- **THEN** `/status` reports that repo's progress as phase `pages`, 12 of 22 units

#### Scenario: Undecomposed planning is labeled, not blank
- **WHEN** a build's planning is one undecomposed session that is in flight and has not yet written a plan
- **THEN** that repo's progress reports the planning phase with the undecomposed marker and no unit counts, rather than a null field

#### Scenario: A preserved partial build stays legible between runs
- **WHEN** a build's planning artifacts and pages were preserved in the work-in-progress area and no run is currently in flight
- **THEN** `/status` reports progress from the preserved artifacts

#### Scenario: A racing read degrades to null
- **WHEN** the status read encounters an artifact mid-write or unreadable
- **THEN** progress for that repo is null and the status request succeeds

#### Scenario: Progress never changes health
- **WHEN** a repo reports planning or page progress
- **THEN** its health colour is still computed from run outcomes and staleness alone
