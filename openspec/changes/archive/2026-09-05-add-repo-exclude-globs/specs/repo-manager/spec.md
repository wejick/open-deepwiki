## ADDED Requirements

### Requirement: Per-repo exclude globs
The registry SHALL store an optional `excludeGlobs` glob list per repo, settable at registration via `repo add --exclude <glob>` (repeatable; comma-separated values accepted) and editable afterwards by editing `registry.yaml`. The effective exclude set for a repo SHALL be the configured global exclude globs merged additively with the repo's list — a repo's globs can only narrow what is indexed, never re-include a path the global list excludes. A repo without the field SHALL index exactly as before. `repo list` SHALL show a repo's exclude globs when set. A change to a repo's globs SHALL take effect on that repo's next indexing run.

#### Scenario: Register repo with excludes
- **WHEN** the user runs `repo add <source> --exclude "**/__snapshots__/**" --exclude "**/*.a"`
- **THEN** the registry entry records both globs, and the repo's first indexing run registers no chunks for paths matching them

#### Scenario: Repo globs extend, not replace, the global list
- **WHEN** the global config excludes `*.lock` and a repo declares `excludeGlobs: ["ci/**"]`
- **THEN** a file matching either list is excluded — the repo list removes `ci/**` files without re-including lock files

#### Scenario: Registry edit applies on next run
- **WHEN** a repo's `excludeGlobs` in `registry.yaml` is extended after its first run, and the repo is updated
- **THEN** chunks for files matched by the new globs no longer participate in search results, with no other index change

#### Scenario: Repo without excludes is unchanged
- **WHEN** a registered repo has no `excludeGlobs` entry
- **THEN** indexing and search behave exactly as with the global exclude list alone

#### Scenario: Excludes visible in listing
- **WHEN** the user runs `repo list` with one repo carrying exclude globs and one without
- **THEN** the first row shows its globs and the second shows none
