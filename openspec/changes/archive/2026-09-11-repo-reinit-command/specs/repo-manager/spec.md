## MODIFIED Requirements

### Requirement: Bare repo command defaults to listing
The CLI SHALL treat a `repo` invocation with no subcommand as `repo list`: the same listing of registered repos on stdout, the same empty-registry output, and exit code 0. The bare invocation SHALL additionally print a hint naming the available `repo` subcommands (`add`, `remove`, `list`, `update`, `reinit`, `instructions`) on **stderr**, so the stdout listing remains pipe-clean. A `repo` invocation with an unrecognized subcommand SHALL exit 1 with a usage message naming the available `repo` subcommands and SHALL NOT fall back to the listing.

#### Scenario: Bare invocation lists repos
- **WHEN** the user runs `repo` with no subcommand and repos are registered
- **THEN** stdout shows the same repo listing `repo list` would show, the exit code is 0, and stderr names the available `repo` subcommands

#### Scenario: Bare invocation with empty registry
- **WHEN** the user runs `repo` with no subcommand and no repos are registered
- **THEN** stdout shows the same "no repos registered" output as `repo list`, the exit code is 0, and stderr still names the available subcommands

#### Scenario: Unknown subcommand still fails
- **WHEN** the user runs `repo frobnicate`
- **THEN** the command exits 1 with a usage message naming the available `repo` subcommands, and no repo listing is printed

## ADDED Requirements

### Requirement: Repository re-initialization
The system SHALL support re-initializing a registered repo's wiki from its existing clone (`repo reinit <repoId>`). The command SHALL acquire the per-repo lock and be refused while another run holds it, then SHALL discard the repo's published bundle, its last-good snapshot and pre-run snapshot, and any work-in-progress build state, SHALL pull the existing clone when one is present, and SHALL run the repo through the initial-build pipeline — whole-repository planning, initial-coverage acceptance, and a full re-index. Registration, the clone, and the index rows SHALL be retained: the command SHALL NOT re-register, re-clone, or purge the repo. The run outcome SHALL be recorded through the same recorder as every other run. A failed re-initialization SHALL NOT restore the discarded bundle or snapshot: the checkout is left without a published wiki, and later runs for the repo rebuild it as an init, so the operator's request to rebuild from scratch is not silently converted into an incremental update of the wiki it discarded.

#### Scenario: Re-initialization rebuilds a repo from its existing clone
- **WHEN** `repo reinit` runs on a registered repo whose clone already exists
- **THEN** the published bundle, snapshot, and work-in-progress state are discarded, the clone is pulled to the current head and reused (not re-cloned), and an init run publishes a fresh bundle, re-indexes the repo, and records its outcome like any other run

#### Scenario: Re-initialization unblocks an exhausted work-in-progress build
- **WHEN** `repo reinit` runs on a repo whose work-in-progress state has exhausted its resume attempts — a state that otherwise stops every subsequent run
- **THEN** the work-in-progress state is discarded and the repo builds again

#### Scenario: A failed re-initialization leaves nothing published
- **WHEN** `repo reinit`'s init run fails
- **THEN** the discarded snapshot is not restored, the checkout has no published bundle, and subsequent runs for the repo execute as init builds

#### Scenario: Re-initialization is refused while another run holds the lock
- **WHEN** `repo reinit` reaches a repo whose per-repo lock is held
- **THEN** the command is refused with a busy message and changes no state

#### Scenario: Re-initialization refuses an unknown repo
- **WHEN** `repo reinit` names a repo that is not registered
- **THEN** the command exits 1 with an error and changes nothing
