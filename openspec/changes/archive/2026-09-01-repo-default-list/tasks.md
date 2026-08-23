## 1. Bare `repo` defaults to list

- [x] 1.1 In `repoCommand` (src/cli/main.ts), dispatch `sub === undefined` to `listRepos(ctx, false)` and print a one-line hint naming the `repo` subcommands (`add`, `remove`, `list`, `update`, `instructions`) to stderr after the listing, returning the listing's exit code. Tests in src/cli/cli.test.ts, named per spec scenarios, dispatching through `main(["repo"])` with `ODW_DATA_DIR` on a tmp config (mirror "repo list through the main dispatcher"): registered fixture repo prints the same listing `repo list` prints on stdout while the hint lands on stderr and exit code is 0 ("Bare repo command defaults to listing › Bare invocation lists repos"); empty registry prints "no repos registered" on stdout, hint on stderr, exit 0 ("Bare repo command defaults to listing › Bare invocation with empty registry").
- [x] 1.2 Pin the unknown-subcommand path: test that `main(["repo", "frobnicate"])` exits 1, writes a usage message naming the subcommands to stderr, and prints no repo listing rows to stdout ("Bare repo command defaults to listing › Unknown subcommand still fails").

## 2. Full-suite validation

- [x] 2.1 Run `bun test ./src ./test`, `bun run lint`, `bun run typecheck`, and `openspec validate --strict` — all green, no network.
