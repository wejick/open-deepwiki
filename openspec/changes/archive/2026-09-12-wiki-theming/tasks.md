## 1. Theme preference plumbing

- [x] 1.1 Add theme resolution and bootstrap to `src/server/wiki.ts`: a pure `parseTheme(value)` (`light | dark | system`, unrecognized → `system`), a request-side reader over `parseCookies`, the `odw_wiki_theme` cookie (`Path=/wiki`, `HttpOnly`, `SameSite=Lax`, one-year max age), `?theme=` handling unified with the existing `?token=` redirect (both cookies in one 302, invalid values ignored), and pass the resolved theme into `renderShell` as `<html data-theme="…">`; cover default, stored cookie, set-and-redirect, invalid value, active toggle marking, combined token+theme, and the no-script case in `src/server/wiki.test.ts`; verify with `bun test src/server/wiki.test.ts`.
- [x] 1.2 Add the topbar theme switch markup (Light / Dark / Auto links, active one `aria-current="true"`, breadcrumb truncated instead of scrolled) and cover it via the rendered HTML in `src/server/wiki.test.ts`.

## 2. Palette and typography

- [x] 2.1 Replace the stylesheet token blocks in `src/server/wiki.ts`: DeepWiki light tokens, Mariana dark tokens with Adaptive-derived surfaces, AA-adjusted pacific-style links, `color-scheme` per theme, and the dark/`system` selector split; assert the `data-theme` selectors and the system media rule in `src/server/wiki.test.ts`.
- [x] 2.2 Apply the DeepWiki content scale (h1–h3, body 1.75, paragraph/list spacing, inline code .85em/600, pre, tables) and the sidebar/caption/outline/topbar sizes with system font stacks; verify via the full suite plus a manual render check of `/wiki/<repoId>`.

## 3. Theme-aware code and diagrams

- [x] 3.1 Register a custom Mariana Shiki theme in `src/server/wikiRender.ts` and render code blocks with the light/Mariana pair, switching the stylesheet selectors to `data-theme`; cover the emitted dark palette values and light/dark/system selection in `src/server/wikiRender.test.ts` and `src/server/wiki.test.ts`.
- [x] 3.2 Make the Mermaid bootstrap pick theme variables from the effective theme (dark when `data-theme="dark"`, or `system` with `prefers-color-scheme: dark`) and cover the dark selection in `src/server/wiki.test.ts`.
- [x] 3.3 Add the outline scroll-spy: an inline script shipped only when the outline is non-empty, marking the heading in view with `aria-current="location"` on its link and styling that mark; cover spy presence and hooks on an outline page and no script on a heading-less page in `src/server/wiki.test.ts`, and update the theme/rails no-script assertions to their reworded scenarios.

## 4. Full verification

- [x] 4.1 Run `bun run test`, `bun run lint`, `bun run typecheck`, `bun run format:check`, and `openspec validate --specs`; fix any failures and confirm every scenario added to `wiki-viewer` has a passing test.
