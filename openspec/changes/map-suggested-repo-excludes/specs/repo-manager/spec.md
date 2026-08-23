## MODIFIED Requirements

### Requirement: Per-repo exclude globs
The registry SHALL store an optional `excludeGlobs` glob list per repo, settable
at registration via `repo add --exclude <glob>` (repeatable; comma-separated
values accepted), editable afterwards by editing `registry.yaml`, and MAY be
extended automatically by a `claude` init split-planning run whose map
proposals passed that producer's exclusion gate (spec: okf-producer › *Claude
producer map exclusion gate*). An automatic extension SHALL follow the same
normalization as a registration — non-empty, trimmed, deduplicated, order
preserved — SHALL only append to the running repo's own list, and SHALL be
additive with the global list exactly as a manual edit is. The effective
exclude set for a repo SHALL be the configured global exclude globs merged
additively with the repo's list — a repo's globs can only narrow what is
indexed, never re-include a path the global list excludes. A repo without the
field SHALL index exactly as before. `repo list` SHALL show a repo's exclude
globs when set. A change to a repo's globs SHALL take effect on that repo's
next indexing run; for a glob an accepted map run applied, that next indexing
run SHALL be the run that applied it.

#### Scenario: Register repo with excludes
- **WHEN** the user runs `repo add <source> --exclude "**/__snapshots__/**" --exclude "**/*.a"`
- **THEN** the registry entry records both globs, and the repo's first indexing run registers no chunks for paths matching them

#### Scenario: Repo globs extend, not replace, the global list
- **WHEN** the global config excludes `*.lock` and a repo declares `excludeGlobs: ["ci/**"]`
- **THEN** a file matching either list is excluded — the repo list removes `ci/**` files without re-including lock files

#### Scenario: Registry edit applies on next run
- **WHEN** a repo's `excludeGlobs` in `registry.yaml` is extended after its first run, and the repo is updated
- **THEN** chunks for files matched by the new globs no longer participate in search results, with no other index change

#### Scenario: Map-run globs are persisted and listed
- **WHEN** a `claude` init run's map gate accepts exclusions and the run completes successfully
- **THEN** the accepted globs are appended to the repo's `excludeGlobs` (normalized, deduplicated, additive), the field reads as the merged list afterwards, and `repo list` shows it when set

#### Scenario: Map-run globs apply to the same run's index
- **WHEN** accepted map globs are persisted for a repo before that run's indexing phase
- **THEN** that run registers no chunks for paths the new globs match

#### Scenario: A failed run leaves the globs unset
- **WHEN** a run whose map gate accepted exclusions later fails or is abandoned
- **THEN** the repo's `excludeGlobs` is unchanged, and no exclusion from that run takes effect

#### Scenario: Repo without excludes is unchanged
- **WHEN** a registered repo has no `excludeGlobs` entry
- **THEN** indexing and search behave exactly as with the global exclude list alone

#### Scenario: Excludes visible in listing
- **WHEN** the user runs `repo list` with one repo carrying exclude globs and one without
- **THEN** the first row shows its globs and the second shows none

### Requirement: Registry write discipline
Writers SHALL persist only the store they own. Run-outcome writers — the
nightly batch, single-repo updates, and initial pipeline runs — SHALL write
only the machine-owned state store (`state.json`) and SHALL NOT rewrite the
human-owned `registry.yaml`. One sanctioned exception: an initial pipeline run
whose `claude` producer reported accepted map exclusion globs SHALL persist
them to the running repo's `excludeGlobs` in `registry.yaml` before that run's
indexing phase, by reloading the file, merging the globs into that repo's list
only, and writing back — never touching any other field or repo — so a
`registry.yaml` edit made mid-run survives. Human-config edits (such as
instructions changes) SHALL write only `registry.yaml` and SHALL NOT rewrite
`state.json`. Registration and removal SHALL write both. A `registry.yaml`
edit made while a batch run is in progress SHALL survive the batch's
completion save.

#### Scenario: Batch end leaves human config untouched
- **WHEN** the nightly batch completes and persists its run outcomes
- **THEN** `state.json` reflects the new outcomes and `registry.yaml` is byte-identical to before the save

#### Scenario: Mid-batch edit survives
- **WHEN** a repo's instructions are edited in the registry while the nightly batch holds its in-memory copy, and the batch then completes
- **THEN** the edited instructions are still present in `registry.yaml` after the batch's save

#### Scenario: Accepted map globs are the run's only registry write
- **WHEN** an initial run accepts map exclusion globs and completes successfully
- **THEN** the only `registry.yaml` change is the running repo's `excludeGlobs` append — merged over a fresh reload so any concurrent edit survives — and no other field or repo entry changes
