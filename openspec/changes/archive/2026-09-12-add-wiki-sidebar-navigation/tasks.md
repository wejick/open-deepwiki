## 1. Sidebar helpers and tree

- [x] 1.1 Add `webCommitUrl(source, sha)` beside `webSourceUrl` in `src/repoManager/webLinks.ts` (GitHub `https://<host>/<path>/commit/<sha>`, GitLab `https://<host>/<path>/-/commit/<sha>`, null for local/unknown hosts or no sha) and cover it in `src/repoManager/webLinks.test.ts`; verify with `bun test src/repoManager/webLinks.test.ts`.
- [x] 1.2 Add a pure `parseIndexOrder(body)` in `src/server/wiki.ts` that extracts Markdown link destinations and labels from an `index.md` body in document order, and a pure `buildNavTree(concepts, orders)` that nests concepts by path, applies per-directory order, appends unlisted entries, and emits directory nodes (label from the index link text, falling back to the path segment); cover ordering, nesting, unlisted pages, and missing `index.md` fallback in `src/server/wiki.test.ts`; verify with `bun test src/server/wiki.test.ts`.
- [x] 1.3 Add a pure `renderSidebar(tree, currentPath, repo)` rendering links to `/wiki/<repoId>/<id>`, `aria-current="page"` on the current concept or directory, and the `Last indexed: <date> (<short sha>)` caption linked via `webCommitUrl` when derivable and plain text otherwise; cover current marking, revision linked/plain/absent, and repo-root (no current entry) in `src/server/wiki.test.ts`.

## 2. Heading anchors and outline

- [x] 2.1 In `src/server/wikiRender.ts`, override the `heading_open` rule to slug h1–h3 headings, disambiguate repeated slugs with `-1`/`-2` suffixes, set the heading `id`, and collect `{level, text, id}` into a per-request `env.outline`; cover id emission, duplicate headings, level ordering, and no-headings in `src/server/wikiRender.test.ts`.
- [x] 2.2 Render the outline in `renderShell` as an "On this page" region of anchor links indented 12px per level, omitted when the outline is empty; cover indentation, link targets, and the empty case in `src/server/wiki.test.ts`.

## 3. Layout and server integration

- [x] 3.1 Rework `renderShell` in `src/server/wiki.ts` to emit `<header class="topbar">` plus a three-region layout (sidebar, content, outline) styled as a CSS grid with a fixed topbar height and sticky, self-scrolling rails; hide the outline at ≤1200px and the sidebar at ≤900px with media queries, no client script; assert the regions, the hide rules, the absence of any rail script on a non-Mermaid page, and the unchanged `/wiki` repo listing (no sidebar) in `src/server/wiki.test.ts`.
- [x] 3.2 Wire `handleWiki` to build the sidebar once per repository page — reading each directory's `index.md` off disk for ordering and `listChunks` for concepts/titles — and to pass the render env's outline into `renderShell`; assert via the test server that a leaf page marks its concept current, a directory listing marks the directory current, the repo root and nested pages render the tree, and the registry revision appears in the header, in `src/server/wiki.test.ts`.

## 4. Full verification

- [x] 4.1 Run `bun run test`, `bun run lint`, `bun run typecheck`, and `openspec validate --specs`; fix any failures and confirm all scenarios added to `wiki-viewer` have a passing test.
