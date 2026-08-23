## Why

`odw repo` typed with no subcommand dies with a usage error and exit 1, yet the most common intent behind it is to see the fleet — the same reflex that makes `git` with no args show something useful. The bare form should just do the useful thing and still teach the available commands.

## What Changes

- `odw repo` with **no subcommand** now runs the `repo list` view and exits 0. After the listing it prints the available `repo` subcommands (`add`, `remove`, `list`, `update`, `instructions`) as a short hint on **stderr**, so stdout stays pipe-clean.
- `odw repo <unknown>` is unchanged: usage error listing the available `repo` subcommands, exit 1.
- No other command's behavior changes (`odw` bare still prints the full usage).

Assumption recorded: "also give available command" is read as a command hint printed alongside the default listing — not a separate interactive menu, and not a change to how unknown subcommands are handled.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `repo-manager`: adds a requirement for the bare `repo` invocation — defaults to the list view with the available subcommands surfaced — and pins the unknown-subcommand error behavior.

## Impact

- `src/cli/main.ts` (`repoCommand` default branch only).
- `src/cli/cli.test.ts` (new scenarios for the bare and unknown forms).
- No config, database, server, producer, or dependency changes.

## Non-goals

- No new flags or output-format changes for `repo list` (`--json` unaffected).
- No change to the bare top-level `odw` behavior (usage + exit 1).
- No interactive menus, prompts, or pager.
- No default-subcommand treatment for any other command group.
