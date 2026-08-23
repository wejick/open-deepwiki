## 1. Dependency

- [x] 1.1 Add `@toon-format/toon` (pin `^4.1.1`) via bun and add the entry to AGENTS.md's allowed-deps list naming the mcp-server "Tool response encoding" requirement; verify `bun install` succeeds and `import { encode, decode } from "@toon-format/toon"` resolves under `bun run typecheck`

## 2. Record tool payloads → TOON

- [x] 2.1 Switch `list_repos`, `search_code`, `list_related`, `ask_repo` (main path), and `server_status` handlers from `JSON.stringify` to TOON `encode`, with `round3` still applied to scores before encoding; join `list_repos` `conceptTerms` into a space-delimited string cell; verify tests "Tool response encoding › Single TOON payload" (strict `decode(text)` deep-equals the payload, result carries no `structuredContent`) and "Tool response encoding › Repo list renders tabular" (`repos[N]{fields}` header, one row per repo) pass, replacing the JSON re-serialization assertion in server.test.ts
- [x] 2.2 Replace the inline `JSON.stringify` in `ask_repo`'s below-threshold message with TOON while keeping the caveat prose; verify test "Tool response encoding › Below-threshold closest matches encoded as TOON" passes
- [x] 2.3 Adapt the score-rounding assertions to the TOON response; verify test "Tool response encoding › Scores rounded to 3 decimals" passes for both `score` and `vectorSim`

## 3. `get_wiki_page` verbatim passthrough

- [x] 3.1 Rewrite the handler to return `encode({repoId, path})` + blank line + raw file contents, dropping the gray-matter parse and the `NO_MATTER_CACHE` import; verify tests "get_wiki_page tool › Fetch file wiki page" (response starts with the two identity lines and a blank line, ends with the fixture file's exact bytes) and a new serving-time assertion (fixture file content unchanged after the call) pass, and "get_wiki_page tool › Wiki page missing" still passes

## 4. Tool description hints

- [x] 4.2 Append the one-line response-format hint to each data-bearing tool description (D6); verify `tools/list` responses contain the hint lines

## 5. Validation

- [x] 5.1 Run `bun test ./src ./test`, `bun run lint`, `bun run format`, `bun run typecheck`, and `openspec validate --specs`; verify all pass with no regressions outside the encoding assertions
