# Repo Manager Specification — delta for add-dashboard

## ADDED Requirements

### Requirement: Registry write discipline
Writers SHALL persist only the store they own. Run-outcome writers — the
nightly batch, single-repo updates, and initial pipeline runs — SHALL write
only the machine-owned state store (`state.json`) and SHALL NOT rewrite the
human-owned `registry.yaml`. Human-config edits (such as instructions
changes) SHALL write only `registry.yaml` and SHALL NOT rewrite
`state.json`. Registration and removal SHALL write both. A `registry.yaml`
edit made while a batch run is in progress SHALL survive the batch's
completion save.

#### Scenario: Batch end leaves human config untouched
- **WHEN** the nightly batch completes and persists its run outcomes
- **THEN** `state.json` reflects the new outcomes and `registry.yaml` is byte-identical to before the save

#### Scenario: Mid-batch edit survives
- **WHEN** a repo's instructions are edited in the registry while the nightly batch holds its in-memory copy, and the batch then completes
- **THEN** the edited instructions are still present in `registry.yaml` after the batch's save
