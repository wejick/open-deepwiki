## Context

`repoCommand` in `src/cli/main.ts` dispatches on `argv[0]`; both a missing and an unrecognized subcommand fall into the same `default:` branch — a usage line plus the full `USAGE` text on stderr, exit 1. The dispatcher already opens the repo context (config, registry, db) before the switch, so a default action needs no extra setup. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**

- Bare `odw repo` runs the existing list view and exits 0, with a subcommand hint that cannot pollute piped stdout.
- Pin the unknown-subcommand error behavior so the two forms stay distinct.

**Non-Goals:**

- Default actions for other commands, new flags, or any change to `repo list` output.

## Decisions

- **Dispatch, not recursion.** When `argv[0]` is undefined, `repoCommand` calls the existing `listRepos(ctx, false)` and then prints the hint before returning its exit code. *Alternatives considered:* re-invoking the switch with `["list", ...rest]` — pointless indirection over a direct call; a new `defaultAction` abstraction — banned seam for a two-line branch.

- **Hint on stderr, listing on stdout.** The spec's pipe-clean guarantee: `odw repo | grep foo` sees only the table. *Alternatives considered:* stdout — would corrupt piped output and force a suppression flag (a config knob with no scenario); printing nothing — fails the discoverability requirement.

- **Unknown subcommand keeps the error.** The `default:` branch is untouched; `repo frobnicate` still exits 1 without running the listing. *Alternatives considered:* defaulting on unrecognized subcommands too — silently running list on a typo hides the mistake; matching git's "unknown command" for the bare case — that is exactly the behavior being fixed.

- **Hint text is a single literal**, not a list derived from a shared constant — the subcommand names already exist as literals in the usage error and the header comment, and a registry of subcommand names would be machinery for two strings. *Alternatives considered:* a `REPO_SUBCOMMANDS` constant consumed by both messages — over-engineering at this scale.

## Risks / Trade-offs

- [Hint noise in captured stderr] → One short line, only on the bare form; scripts capturing stderr are already tolerant of usage chatter.
- [Future subcommands can drift out of the hint] → The hint and the error message sit within ten lines of each other in one file; the spec scenarios assert the names.

## Migration Plan

None — single-file CLI change, no persisted state, rollback is reverting the branch.

## Open Questions

None.
