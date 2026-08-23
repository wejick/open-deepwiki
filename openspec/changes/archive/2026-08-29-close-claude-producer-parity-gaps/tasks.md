## 1. Index synchronization (`src/producer/finalize.ts`)

- [x] 1.1 Implement `syncIndexes(bundleDir)`: for every directory in the bundle, regenerate `index.md` from the concept pages and subdirectories actually present on disk (title from frontmatter `title`, falling back to filename; description from frontmatter `description`), preserving the root index's `okf_version: "0.2"` frontmatter marker and leaving nested indexes frontmatter-free, matching the existing `RESERVED_NAMES`/`walkMd` conventions in `verify.ts`; verify unit tests: regenerates a directory with existing hand-authored content, regenerates a directory with a missing `index.md`, root marker preserved, nested index has no frontmatter, a directory with only subdirectories (no pages) still lists them

## 2. Mermaid parsing and degrade (`src/producer/finalize.ts`)

- [x] 2.1 Add `jsdom` to `package.json` (`mermaid` is already a dependency); add both to the AGENTS.md "Allowed deps" list naming the requirement they serve (Mermaid diagram validation for the `claude` producer's finalize pass); verify `bun install` succeeds and `tsc --noEmit` passes
- [x] 2.2 Implement `loadMermaid()`: a lazy-loaded, memoized loader that installs `jsdom`'s `window`/`document` as DOM globals before importing `mermaid` for the first time (ordering matters — mermaid's flowchart/state-diagram parsers call DOMPurify, which needs a DOM), and ensure nothing else in the codebase imports `mermaid` directly for parsing; verify a unit test that the loader is idempotent (second call reuses the same instance) and that DOM globals exist before mermaid is touched
- [x] 2.3 Implement `findInvalidMermaidFences(markdown)`: extract every ` ```mermaid ` fence and, via `loadMermaid()`, parse each with `mermaid.parse`, catching a thrown parse error and treating it as invalid rather than propagating; verify unit tests: a valid flowchart and a valid sequence diagram both pass, a syntactically broken diagram is flagged, a parser exception is caught and treated as invalid, a fence with no issues is untouched
- [x] 2.4 Implement `degradeInvalidMermaidFences(markdown)`: rewrite each invalid fence (bottom-up, so earlier line indices stay valid) to a plain text fence carrying the original content, preceded by an HTML comment recording the failure; verify unit tests: single invalid fence degraded, multiple fences in one document handled independently with only the invalid ones rewritten, a document with no invalid fences returned unchanged

## 3. Wire finalization into the `claude` producer

- [x] 3.1 Add `finalizeClaudeBundle(bundleDir)` combining 1.1 + 2.4, called from `runClaude` in `claude.ts` after the child process is classified `ok` and before the run returns, so it also covers the repair retry (which calls `runClaude` again); verify unit tests in `claude.test.ts`: a fixture bundle with a stale `index.md` and an invalid Mermaid fence is corrected before `runClaude` returns `ok`, a bundle that fails to spawn/times out/rate-limits is never finalized
- [x] 3.2 Verify `contract.test.ts`'s existing grep-based invariant still passes (no new `producerId === ...` branch introduced outside `isolation.ts`) and add an assertion (if not already covered) that `finalize.ts` contains no producer-id branching, confirming the mutation stays scoped to the `claude` code path by construction, not by a runtime check

## 4. Bundle link-resolution scoring (`src/producer/acceptance.ts`)

- [x] 4.1 Export `LINK_RE` from `src/index/ingest.ts` alongside the already-exported `resolveLink`/`joinBundlePath`, so scoring reuses the indexer's own link-parsing regex instead of a second one; verify `tsc --noEmit` passes and existing `ingest`/`index` tests are unaffected
- [x] 4.2 Implement `scoreLinks(bundle)` in `acceptance.ts`: walk concept pages, extract in-body links via `LINK_RE`, resolve each with `resolveLink` against the bundle's concept-id set, and return `{resolved, total, ratio}`; verify unit tests: a page with only resolving links scores 1, a page with one unresolved link is reflected in the ratio, a non-`.md`/external link is excluded from `total`, the existing `test/fixtures/bundles/valid` fixture (with its deliberately unresolved `guide.md` link) scores below 1 without erroring
- [x] 4.3 Add `ODW_LINK_MIN` to `config.ts` (`z.coerce.number().min(0).max(1).default(0)`, mirroring `ODW_GROUNDING_MIN`) threaded through to `cfg.link.min`; verify a unit test that the default is 0
- [x] 4.4 Wire `scoreLinks` into `acceptBundle`: compute it after grounding, add a `"link"` failure kind, reject when `linkScore.ratio < cfg.link.min`, and add `linkScore` to `AcceptanceResult`; verify unit tests: default floor (0) accepts a bundle with an unresolved link, a configured floor rejects a below-floor bundle and restores the last verified bundle, the check is producer-independent (identical bundle content scores identically regardless of nominal producer)

## 5. Grounding line-range tightening (`src/producer/grounding.ts`)

- [x] 5.1 Extend citation resolution so a `resource` carrying a `#Lstart-Lend` (or single-line `#Lstart`) fragment is checked against the cited file's actual line count, counting the citation as unresolved when the range exceeds it; verify unit tests: an in-range fragment still resolves, an out-of-range `Lend` is counted unresolved, the existing single-line and no-fragment cases behave unchanged, `scoreGrounding`'s aggregate score reflects an out-of-range citation the same as a fabricated path

## 6. Authoring skill guidance (`SKILL.md`)

- [x] 6.1 Add guidance to close every page with a related-pages section (links to related pages, each with a short description) and to bold a term the first time it is formally introduced; verify `claude.test.ts` assertions that the generated prompt includes both instructions
- [x] 6.2 Add guidance to write a `tags` frontmatter field of relevant kebab-case terms and to quote every Mermaid node label; verify `claude.test.ts` assertions for both
- [x] 6.3 Add guidance to prefer a citation scoped to the specific supporting lines (`repo://path#Lstart-Lend`) over a whole-file citation when the relevant lines can be identified; verify a `claude.test.ts` assertion
- [x] 6.4 Add guidance for plain, direct prose: no contrastive-redefinition constructions ("it's not X, it's Y"), no hedging or filler phrasing; verify a `claude.test.ts` assertion

## 7. Integration, verification, and docs

- [x] 7.1 Run `bun test ./src ./test`, `bun run lint`, `bun run typecheck`, and `openspec validate close-claude-producer-parity-gaps --strict`; all green
- [x] 7.2 Update the "Bundle acceptance" table in `AGENTS.md` with a row for the new link-resolution score, and note the `claude`-only finalization pass in the producer-contract summary, so the file stays accurate as the project's own source of truth
