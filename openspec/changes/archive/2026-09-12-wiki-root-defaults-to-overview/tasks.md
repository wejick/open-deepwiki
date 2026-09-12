## 1. Root overview default

- [x] 1.1 Rework `handleWiki`'s empty-`rest` branch in `src/server/wiki.ts` to try `renderConceptPage(db, repo, "overview")` first, fall back to `renderIndexPage(db, repo, "")` when it returns null, and pass `"overview"` as the sidebar's current path when the concept rendered; cover in `src/server/wiki.test.ts` with the `valid` fixture (root returns 200 and the overview body, the sidebar marks the overview entry `aria-current="page"`, the outline is present) and with `openwiki-authored` (no top-level overview still renders the listing, unknown repo/page 404s unchanged, and an overview whose file was removed falls back to the listing); verify with `bun test src/server/wiki.test.ts`.

## 2. Full verification

- [x] 2.1 Run `bun run test`, `bun run lint`, `bun run typecheck`, `bun run format:check`, and `openspec validate --specs`; fix any failures and confirm both modified `wiki-viewer` requirements' scenarios have passing tests.
