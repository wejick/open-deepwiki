## MODIFIED Requirements

### Requirement: Add repository with pre-flight validation
The server SHALL accept `POST /api/repos` with a JSON body
`{ "source": "<git-url|local-path>", "producer": "<producer-id>", "excludeGlobs": ["<glob>", ...] }`,
where `producer` and `excludeGlobs` are optional. Before registering, it SHALL
validate the source with a fast pre-flight check — `git ls-remote` for remote
URLs, existence plus a git-worktree check for local paths — and reject
failures with 400 and a clear error, registering nothing. An
already-registered source SHALL be rejected with 409. A `producer` value that
is present, non-empty, and not a known producer id SHALL be rejected with 400
and an error naming the valid ids, registering nothing and starting no run.
An absent, null, or empty `producer` SHALL record no per-repo override, so
the repo follows the global default — the same behavior as `repo add` without
`--producer`. A valid `producer` SHALL be persisted as that repo's override,
and the repo's first run SHALL use it. An `excludeGlobs` value SHALL be an
array of non-empty strings; any other shape — not an array, an empty or
whitespace-only entry, a non-string entry — SHALL be rejected with 400 and a
clear error, registering nothing and starting no run. Valid `excludeGlobs`
SHALL be persisted as the repo's per-repo exclude globs, merged additively
with the global exclude configuration for that repo's runs. An absent, null,
or empty `excludeGlobs` SHALL record no per-repo globs. On success the server
SHALL register the repo (same repoId normalization and duplicate handling as
the CLI), report the producer that will run, and start the initial pipeline
run.

#### Scenario: Unreachable remote rejected
- **WHEN** a client posts a git URL that `git ls-remote` cannot reach
- **THEN** the response is 400 with the pre-flight error and no repo is registered

#### Scenario: Duplicate source rejected
- **WHEN** a client posts a source that is already registered
- **THEN** the response is 409 and the registry is unchanged

#### Scenario: Valid source accepted
- **WHEN** a client posts a valid local git path
- **THEN** the response is 202 with the assigned repoId and the repo appears in the registry

#### Scenario: Producer override persisted
- **WHEN** a client posts a valid source with `producer` set to a known non-default id
- **THEN** the response is 202, the registered repo carries that producer as its override, and the reported producer is that id

#### Scenario: Omitted producer follows the global default
- **WHEN** a client posts a valid source with no `producer` field
- **THEN** the registered repo records no producer override, and the reported producer is the configured global default

#### Scenario: Unknown producer rejected before any work
- **WHEN** a client posts a source with a `producer` value no producer implements
- **THEN** the response is 400 with an error naming the valid producer ids, nothing is registered, and no pre-flight or pipeline work is performed

#### Scenario: Exclude globs persisted with the registration
- **WHEN** a client posts a valid source with `excludeGlobs: ["**/*.snap", "**/*.a"]`
- **THEN** the response is 202, the registered repo carries both globs, and its first run indexes no path matching them

#### Scenario: Malformed exclude globs rejected before any work
- **WHEN** a client posts a source with `excludeGlobs` set to a non-array, a non-string entry, or an empty string entry
- **THEN** the response is 400 with a clear error, nothing is registered, and no pre-flight or pipeline work is performed

#### Scenario: Omitted exclude globs record none
- **WHEN** a client posts a valid source with no `excludeGlobs` field, `null`, or an empty array
- **THEN** the registered repo records no per-repo globs and its runs use the global exclude list alone
