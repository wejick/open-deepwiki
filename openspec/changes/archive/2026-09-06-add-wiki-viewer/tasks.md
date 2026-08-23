## 1. Dependencies and auth primitive

- [x] 1.1 Add `markdown-it` + `shiki` + `mermaid` to `package.json`; serve Mermaid's published `dist/` directory (its ESM entry plus the 200+ per-diagram-type chunks it dynamically imports at runtime — a single vendored file 404s on every real diagram) under `/wiki/assets/mermaid/`, read per request rather than preloaded; verified `bun install` succeeds, `tsc --noEmit` passes, and a real browser render actually loads its chunks (see 7.2)
- [x] 1.2 Implement the repoId/path split in `src/server/wiki.ts`: longest-prefix match of the request path against `registry.repos[].repoId`; verify unit tests for an exact-repoId root path, a repoId + concept path, a repoId + directory path, and no-registered-prefix (spec: *Wiki page routing*)
- [x] 1.3 Implement `/wiki/*` cookie auth: validate a `Cookie` header token against `cfg.bearerToken`, exempt localhost binds using the same condition `server.ts` already applies at line 186; `GET /wiki?token=<token>` sets the cookie; verify unit tests for valid cookie, missing/invalid cookie + token on a non-localhost bind (401), bootstrap setting the cookie, and localhost exemption (spec: *Wiki authentication*)

## 2. Markdown rendering

- [x] 2.1 Build one reused `markdown-it` instance wired to a Shiki highlighter, with a `fence` rule override so a ` ```mermaid ` block emits `<pre class="mermaid">` with the raw diagram source instead of being highlighted; verify unit tests asserting a tagged code block is syntax-highlighted and a `mermaid` block is passed through raw (spec: *Rendered page content*)
- [x] 2.2 Add a link-rewrite renderer rule that reuses `resolveLink` ([ingest.ts](../../../src/index/ingest.ts)) against the current repo's concept id set to rewrite resolvable link `href`s to `/wiki/<repoId>/<conceptId>`; verify unit tests for a relative link, a bundle-root-absolute link, and a link that does not resolve to any concept (left untouched) (spec: *Cross-page link resolution*)
- [x] 2.3 Render a concept page: `getChunk` + frontmatter/body split (same pattern `tools.ts` already uses for `get_wiki_page`) piped through 2.1+2.2 into an HTML fragment; verify a unit test against the `two-modes.md` fixture asserting the diagram, a highlighted code block, and rewritten links are all present in one render

## 3. Directory navigation and breadcrumb

- [x] 3.1 Render repo-root and directory listings by reading `index.md` directly from the bundle checkout (never through the DB, since `index.md` is excluded from indexing) through the same rendering pipeline as 2.3; verify unit tests against the fixture bundle's root `index.md` and `architecture/index.md` (spec: *Wiki page routing*, directory scenario)
- [x] 3.2 Build the breadcrumb: repoId plus each path segment, every segment before the current page linking to its directory listing or page, the current page as plain text; verify unit tests for a leaf-page breadcrumb and a directory-page breadcrumb (spec: *Breadcrumb navigation*)

## 4. Page shell and repo listing

- [x] 4.1 Compose the full HTML page: reading-focused inline CSS (constrained prose width, code block styling, `prefers-color-scheme` dark mode), breadcrumb bar, content region, and a Mermaid bootstrap `<script type=module>` included only when the rendered fragment contains `class="mermaid"`; verify a unit test asserting the script tag is present for a diagram page and absent otherwise
- [x] 4.2 Implement `GET /wiki`: list every `registry.repos[].repoId`, each linking to `/wiki/<repoId>`; verify unit tests for a populated registry and an empty one (spec: *Repo directory listing*)

## 5. Routing and error handling

- [x] 5.1 Mount `/wiki`, `/wiki?token=`, and `/wiki/<repoId...>/<path...>` in `server.ts`'s route dispatch, wired through the 1.3 auth check; verify integration tests for 401 without a session on a non-localhost bind, a token bootstrap followed by a cookie-authenticated request succeeding, and localhost working unauthenticated
- [x] 5.2 Add 404 handling for an unmatched repoId prefix and for a path that resolves to a known repo but no matching concept or directory; verify one test per case (spec: *Wiki page routing*, unknown-repo and unknown-page scenarios)

## 6. Integration and verification

- [x] 6.1 Add an end-to-end test that serves the fixture registry/bundle ([test/fixtures/bundles/openwiki-authored](../../../test/fixtures/bundles/openwiki-authored)) and walks repo list → repo root → a leaf page with a diagram, highlighted code, and cross-links → a directory breadcrumb link, asserting the rendered HTML at each step
- [x] 6.2 Run `bun test ./src ./test`, `bun run lint`, `bun run typecheck`, and `openspec validate add-wiki-viewer --strict`; new/changed files are clean under all four (the repo's pre-existing `no-await-in-loop` lint warnings elsewhere are unrelated to this change)

## 7. Documentation

- [x] 7.1 Document the `/wiki` surface in the README alongside the existing dashboard section: URL shape and the `/wiki?token=` bootstrap link
- [x] 7.2 Manual browser pass: served the fixture bundle and clicked through the repo list, a directory, a leaf page with a Mermaid diagram and highlighted code, and breadcrumb navigation, in both light and dark `prefers-color-scheme`. Caught and fixed two real bugs this way: root `index.md`'s frontmatter was rendering as literal visible text (fixed by stripping it like concept pages), and the Mermaid diagram didn't render at all — its ESM entry dynamically imports per-diagram-type chunk files from beside itself, which 404'd when only the single entry file was served (fixed per 1.1)
