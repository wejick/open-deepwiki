## ADDED Requirements

### Requirement: Per-repo wiki instructions configuration
The system SHALL store an optional per-repo wiki instructions field (`instructions`, a multiline string) in the registry entry for each repo. `repo add <source> --instructions <file>` SHALL set it from a file, `--instructions -` SHALL read it from stdin, and repos added without the flag SHALL have no instructions.

#### Scenario: Add repo with instructions file
- **WHEN** the user runs `repo add git@gitlab.corp:team/repo.git --instructions ./wiki-prompt.md`
- **THEN** the registry entry for the new repo contains the file's content as its `instructions` field

#### Scenario: Add repo without instructions
- **WHEN** the user runs `repo add` without `--instructions`
- **THEN** the registry entry has no `instructions` field and wiki generation uses openwiki's default behavior

### Requirement: Instructions seeding before wiki runs
Before every openwiki run (`--init` and `--update`), the system SHALL write the repo's configured instructions (when present and non-empty) to `<checkout>/openwiki/INSTRUCTIONS.md` — the file openwiki reads as the per-repo wiki goal. When a repo has no instructions configured, the system SHALL NOT touch that file. Seeding SHALL apply on every run, so the configured prompt wins even after openwiki's agent edits the file.

#### Scenario: Custom prompt reaches openwiki
- **WHEN** a repo with configured instructions runs `openwiki --init`
- **THEN** `<checkout>/openwiki/INSTRUCTIONS.md` contains exactly the configured instructions before openwiki starts

#### Scenario: No instructions leaves the file untouched
- **WHEN** a repo without configured instructions runs an update and its bundle already has an `INSTRUCTIONS.md`
- **THEN** the existing file is left as-is

#### Scenario: Update re-applies configured instructions
- **WHEN** openwiki's agent rewrote `<checkout>/openwiki/INSTRUCTIONS.md` during a previous run and the repo has configured instructions
- **THEN** the next run re-writes the configured instructions before openwiki starts

### Requirement: Instructions CLI surfaces
The system SHALL provide `repo instructions <repoId>` printing the repo's configured instructions (or a clear message when none are set), SHALL fail with a clear error for unknown repoIds, and SHALL indicate in `repo list` output which repos have custom instructions configured.

#### Scenario: Show instructions
- **WHEN** the user runs `repo instructions gitlab.corp/team/repo` on a repo with configured instructions
- **THEN** the configured instructions are printed

#### Scenario: Unknown repo
- **WHEN** the user runs `repo instructions` for an unregistered repoId
- **THEN** the command fails with a clear error

#### Scenario: List flags custom instructions
- **WHEN** the user runs `repo list` and one repo has configured instructions
- **THEN** that repo's row is marked as having custom instructions
