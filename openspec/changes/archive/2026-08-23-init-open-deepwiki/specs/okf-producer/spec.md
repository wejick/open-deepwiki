## ADDED Requirements

### Requirement: Non-interactive openwiki invocation
The producer adapter SHALL invoke the pinned `openwiki` CLI as a child process — `openwiki --init` on first add and `openwiki --update` on subsequent runs — against the managed repo clone in one-shot non-interactive mode, capturing stdout/stderr, with a configurable timeout.

#### Scenario: Initial run produces a bundle
- **WHEN** a repo is added and the adapter runs `openwiki --init` on its fresh clone
- **THEN** the CLI completes non-interactively and an OKF bundle directory exists at `<clone>/openwiki/`

#### Scenario: Update run on unchanged repo
- **WHEN** the adapter runs `openwiki --update` on a repo whose head is unchanged since the last successful run
- **THEN** the CLI completes without regenerating wiki content (no-op run)

### Requirement: Isolated and pre-seeded openwiki configuration
The adapter SHALL run openwiki with an isolated openwiki home under the data directory — openwiki v0.3 hardcodes `~/.openwiki` (no config-dir env override), so the child process is spawned with `HOME=<dataDir>/openwiki-config`, where the adapter SHALL pre-seed provider credentials (from our config) before the first invocation, so that no interactive onboarding is required.

#### Scenario: First run without wizard
- **WHEN** `openwiki --init` is invoked with a pre-seeded config dir containing provider credentials
- **THEN** the run proceeds without prompting for provider, key, or model selection

### Requirement: Version pinning
The adapter SHALL pin the openwiki CLI version (default from config, e.g. `^0.3`) and SHALL surface the installed version in diagnostics; a configured override SHALL be honored.

#### Scenario: Version mismatch warning
- **WHEN** the installed openwiki major version differs from the pinned expectation
- **THEN** the adapter logs a warning and still attempts the run

### Requirement: OKF v0.2 bundle verification
After each openwiki run, the adapter SHALL verify the produced bundle conforms to OKF v0.2: every non-reserved `.md` file has parseable YAML frontmatter with a non-empty `type`, and the root `index.md` is present. Reserved files (`index.md`/`log.md` — structural table-of-contents and changelog files, which openwiki also emits at section subdirectories) SHALL be exempt from the frontmatter check at any depth.

#### Scenario: Valid bundle accepted
- **WHEN** a run finishes and every concept file parses with a non-empty `type`
- **THEN** the bundle is marked verified and handed to the indexer

#### Scenario: Malformed bundle rejected
- **WHEN** a run finishes but a concept file has missing frontmatter or an empty `type`
- **THEN** the adapter reports a verification failure for that run

### Requirement: Failure isolation
If an openwiki run fails (non-zero exit, timeout, or verification failure), the adapter SHALL surface the error, preserve the last previously verified bundle untouched, and leave the repo's indexed state unchanged.

#### Scenario: Failed update keeps last good bundle
- **WHEN** `openwiki --update` exits non-zero on a previously indexed repo
- **THEN** the error is reported and the previous OKF bundle and index remain in place and queryable
