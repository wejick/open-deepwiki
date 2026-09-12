## 1. Citation parser and renderer

- [x] 1.1 Add `parseInlineCitation(text)` to `src/server/wikiRender.ts` (grammar `path:start-end`, `path:start`; null otherwise) and a `sourceLinks` map to `RenderEnv`; override the `code_inline` rule to emit `<a href><code>…</code></a>` when the map has the span; verify with unit tests in `src/server/wikiRender.test.ts` covering ranged, single-line, no-range, and non-path spans plus the link rendering
- [x] 1.2 Add `inlineSourceLinks(body, repo)` to `src/server/wiki.ts` resolving each unique mention against `repo.clonePath` (containment + file stat) through `webSourceUrl`, and wire it into `renderConceptPage`'s env; verify in `src/server/wiki.test.ts` with `serveWiki` gaining a checkout-files option: GitLab/GitHub links, single-line fragment, missing-file and local-repo fallbacks, fenced block untouched
- [x] 1.3 Accept the hash citation grammar (`path#Lstart-Lend`, `path#Lstart`) in `parseInlineCitation`; verify with parser and viewer tests and against the real goal-lifecycle page

## 2. Verification

- [x] 2.1 Run `bun run lint`, `bun run typecheck`, and `bun run test`; verify all pass
- [x] 2.2 Render the real opencode-goal page through `inlineSourceLinks` and verify `goal.ts:633-661` resolves to `https://github.com/wejick/opencode-goal/blob/<lastIndexedSha>/goal.ts#L633-L661`
