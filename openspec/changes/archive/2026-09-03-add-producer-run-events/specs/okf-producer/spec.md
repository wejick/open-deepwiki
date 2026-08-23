# okf-producer spec delta

## MODIFIED Requirements

### Requirement: Producer contract
The system SHALL hold every OKF producer to one contract. Given the managed clone, the run mode, the commit the existing bundle was generated from, the source paths changed since that commit, and the frontmatter `type` vocabulary already in use, a producer SHALL write the OKF bundle to `<clone>/openwiki/`, SHALL modify nothing else in the checkout, and SHALL report exactly one outcome: `ok`, `failed`, or `rate_limited`. Bundle acceptance — conformance, grounding, scoped-update checks, repair retry, snapshot restore, and continuity metadata — SHALL be performed by the system identically for every producer and SHALL NOT be delegated to a producer. Producers SHALL reuse the existing run cycle: the per-repo lock, the queue, and the terminal run event sequence SHALL be the same regardless of which producer ran. A producer with observable internal stages MAY interleave `producer_progress` events between the run's start and its terminal event; a producer that runs as a single child process emits none.

#### Scenario: Acceptance is identical across producers
- **WHEN** either producer completes a run
- **THEN** the bundle passes through the same conformance, grounding, scoped-update, and isolation path, with no producer-specific bypass

#### Scenario: Run cycle is unchanged by producer choice
- **WHEN** the same repo is run once under each producer
- **THEN** both runs take the per-repo lock and emit the same terminal sequence of run events, differing only in the recorded producer and outcome; a producer with observable stages may interleave `producer_progress` events between the lifecycle events

#### Scenario: Self-diffing producer ignores the supplied change set
- **WHEN** a producer that derives its own change set is given one
- **THEN** it ignores the supplied paths and the run's acceptance is unaffected
