## ADDED Requirements

### Requirement: Bare repo command defaults to listing
The CLI SHALL treat a `repo` invocation with no subcommand as `repo list`: the same listing of registered repos on stdout, the same empty-registry output, and exit code 0. The bare invocation SHALL additionally print a hint naming the available `repo` subcommands (`add`, `remove`, `list`, `update`, `instructions`) on **stderr**, so the stdout listing remains pipe-clean. A `repo` invocation with an unrecognized subcommand SHALL exit 1 with a usage message naming the available `repo` subcommands and SHALL NOT fall back to the listing.

#### Scenario: Bare invocation lists repos
- **WHEN** the user runs `repo` with no subcommand and repos are registered
- **THEN** stdout shows the same repo listing `repo list` would show, the exit code is 0, and stderr names the available `repo` subcommands

#### Scenario: Bare invocation with empty registry
- **WHEN** the user runs `repo` with no subcommand and no repos are registered
- **THEN** stdout shows the same "no repos registered" output as `repo list`, the exit code is 0, and stderr still names the available subcommands

#### Scenario: Unknown subcommand still fails
- **WHEN** the user runs `repo frobnicate`
- **THEN** the command exits 1 with a usage message naming the available `repo` subcommands, and no repo listing is printed
