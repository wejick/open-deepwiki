## Why

`/wiki` has only an implicit `prefers-color-scheme` dark mode with GitHub-ish colors and browser-default typography, and no way to choose or persist a preference. We adopt DeepWiki's restraint — compact heading scale, 1.75 body leading, warm paper light palette — and give dark mode a Sublime Mariana identity, selectable and persisted without client-side JavaScript.

## What Changes

- Theme is resolved server-side from a long-lived `odw_wiki_theme` cookie (`light` | `dark` | `system`, absent = `system`) and rendered as `<html data-theme="…">`, so the first paint is already themed.
- The toggle is zero-JS: `?theme=<value>` links in the topbar set the cookie and redirect to the same path (the `?token=` bootstrap pattern).
- Restyle `/wiki` to the DeepWiki scale (h1 22px, body 16px/1.75, code .85em/600) with system font stacks and the DeepWiki paper light palette plus a Sublime Mariana dark palette whose surfaces follow Sublime's Adaptive derivation (+4% / +8% / +12% lightness); links carry no accent color — they inherit the text color at weight 500 with an underline.
- Code and diagrams follow the active theme: Shiki's dark palette becomes a custom Mariana theme switched by `data-theme`, and Mermaid initializes with theme variables picked from the effective theme.
- Scope is `/wiki` only; the cookie's `Path=/wiki` keeps the dashboard, admin API and MCP untouched.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wiki-viewer`: new requirements for the theme preference (cookie, zero-JS toggle, server-rendered attribute) and for theme-aware code/diagram rendering.

## Non-goals

- A client-side theme script, `localStorage`, or flash-of-unstyled-theme workarounds.
- Font files or font dependencies — system stacks now, a typeface later if wanted.
- Dashboard, admin, or MCP theming.
- Layout changes beyond what the palette and scale touch.

## Impact

- `src/server/wiki.ts` — cookie/query resolution, `renderShell`, topbar switch, stylesheet.
- `src/server/wikiRender.ts` — custom Mariana Shiki theme.
- `src/server/wiki.test.ts`, `src/server/wikiRender.test.ts` — new scenarios.
- Spec: `openspec/specs/wiki-viewer/spec.md` (via delta).
