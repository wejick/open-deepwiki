## 1. Forge URL helper

- [x] 1.1 Extract the remote parser currently inline in `repoIdFromSource` into a shared case-preserving `parseRemote` in `src/repoManager/registry.ts` and rewire `repoIdFromSource` through it; verify the existing `src/repoManager/repoManager.test.ts` repoId assertions (scp-like, https, ssh-with-port, local path) still pass unchanged
- [x] 1.2 Add `src/repoManager/webLinks.ts` exporting `webSourceUrl(source, sha, path, range)` with provider inference, `.git`/trailing-slash/port stripping, path percent-encoding, per-provider fragments, and null fallbacks; verify with a new `src/repoManager/webLinks.test.ts` covering GitLab and GitHub permalinks (range, single line, no range), scp-like / `ssh://host:2222` / https sources, case-preserved paths with spaces, and local path / unknown host / null sha → null

## 2. Wiki viewer Sources section

- [x] 2.1 Add `test/fixtures/bundles/sourced/` (`index.md`, `cited.md` carrying ranged, bare, and non-`repo://` sources, `plain.md` with none) without touching the shared `valid` bundle; verify the bundle indexes with `indexRepo` in a test before wiring rendering
- [x] 2.2 Render a Sources section in `renderConceptPage` (`src/server/wiki.ts`) using `citedPath`/`lineRangeOf` from `src/producer/grounding.ts` plus `webSourceUrl`, producing anchors when derivable and plain `path:start-end` code text otherwise, with entries escaped; verify in `src/server/wiki.test.ts` the GitLab link, GitHub link, no-fragment, single-line, local-repo text fallback, non-`repo://` omission, and no-sources-section scenarios

## 3. MCP search result URLs

- [x] 3.1 Add `url: string | null` to `serializeHits` (`src/server/tools.ts`), computed via `webSourceUrl` for `source`-kind results from a registry map (the `repoExcludesFor` shape) using the result's first line range; verify in `src/server/server.test.ts` with a checkout source file that a scoped search returns the GitLab permalink, wiki-kind results are null, local-source and unindexed repos are null, and cross-repo results carry their own repo's URL (extend `serveFixture` with checkout files as needed)
- [x] 3.2 Verify the new field survives the existing strict TOON decoding and the below-threshold `ask_repo` path; add an `ask_repo` source-result URL assertion alongside the existing payload tests

## 4. Verification

- [x] 4.1 Run `bun run lint`, `bun run typecheck`, and `bun run test`; verify they pass and `get_wiki_page` output is byte-for-byte unchanged
- [ ] 4.2 Spot-check one real indexed repo: follow a GitLab and a GitHub citation link from a rendered `/wiki` page and confirm the `/-/blob/<sha>/...#L` target opens the cited lines (manual, live forge)
