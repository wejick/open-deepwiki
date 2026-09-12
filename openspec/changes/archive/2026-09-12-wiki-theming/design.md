## Context

See proposal.md — Why. Current state that shapes the approach:

- `renderShell` (`src/server/wiki.ts`) renders one HTML string with a single `<style>` block; theme colors are CSS custom properties under `:root` with a `@media (prefers-color-scheme: dark)` override.
- `?token=` on any `/wiki/*` path already sets a cookie and 302s to the pathname without the query — the exact pattern the zero-JS theme toggle reuses.
- `wikiRender.ts` renders Shiki with `defaultColor: false`, emitting both `--shiki-light`/`--shiki-dark` values; the stylesheet chooses between them only by media query today.
- The Mermaid bootstrap is a const string included only on pages with diagrams; its `initialize` call currently takes no theme.
- Tests assert rendered HTML and stylesheet substrings; there is no browser.

## Goals / Non-Goals

**Goals**

- Server-resolved theme with no first-paint flash, no client script, and a testable cookie/query contract.
- DeepWiki's type scale and light palette; a dark mode that is identifiably Sublime Mariana, with surfaces derived the way Sublime's Adaptive theme derives them.

**Non-Goals**

- Dashboard/admin theming, font assets, client-side toggling, or layout changes beyond palette and scale.

## Decisions

### Server-resolved theme, zero-JS toggle

The cookie (`odw_wiki_theme`, `Path=/wiki`, `HttpOnly`, `SameSite=Lax`, one-year max age) is read per request and rendered as `<html data-theme="…">`; `?theme=` on any `/wiki/*` path sets it and 302s to the pathname, mirroring the token bootstrap. The dark token block appears once under `[data-theme="dark"]` and once under `@media (prefers-color-scheme: dark) { [data-theme="system"] }`; `color-scheme` is set per theme.

- Alternatives considered: a client script (introduces a second `/wiki` script, a possible flash before it runs, and DOM-only testability); `localStorage` (forces a client-first render and cannot survive the no-JS guarantee); `?theme=` rendering the page directly without redirect (breaks back/reload URL hygiene).
- `HttpOnly` is possible precisely because no script reads the cookie.

### Light tokens are DeepWiki's; dark tokens are Mariana's

Light: background `#f8f7f6`, surface `#f2f1f0`, hover `#e8e8e8`, border `#e0e0e0`, text `#333`, muted `#666`, code block `#f1f1f1`. Dark: Mariana's `blue3` background `#303841`, `white3` text `#d8dee9`, comment `blue6` muted `#a6acb9`, with surfaces derived by Sublime's Adaptive rule — `+4%` surface `#384049`, `+8%` hover `#414850`, `+12%` border `#495058`; code block uses the embedded-source tint `#363e47`, inline code the `blue2` blend `#3e4852`, selection `blue2 @70%` `#4d5864`.

- Alternatives considered: Monokai (its comment token measures 3.0:1, failing as UI muted text, and its olive-black full page is a stronger commitment than a reading surface wants); inventing surfaces for Mariana by eye (Adaptive's rule is Sublime's own and keeps the chrome coherent with the scheme).
- Note the modes intentionally differ in temperature (warm paper / cool slate); each is internally coherent and both carry the same token names.

### Links carry no accent color

Article links inherit the text color at weight 500 with an underline; the chrome's hover states resolve to the text color too. This keeps the palette to one foreground and one muted tone per mode, so the syntax palette and diagrams stay the only chromatic elements.

- Alternatives considered: DeepWiki's pacific (`#6096ff`) fails AA on the paper background (2.69:1) and needed a different value per mode anyway; a Mariana-tuned blue (`#85b2e0`) still introduced a second accent competing with the code palette.
- Underline plus weight keeps links distinguishable from body text without relying on color.

### DeepWiki's content scale with system font stacks

Adopted: h1 1.375rem/700/1.875rem, h2 1.25rem/700/1.75rem, h3 1.2em/~600/1.65, body 16px/1.75, paragraph margins 1.15em, list items 0.35em, inline code .85em/600, pre .85em/1.75 with `.857em/1.14em` padding and 6px radius, tables .875em/1.5. Chrome: sidebar 14px, revision caption 12px, topbar 14px, and the outline rail at DeepWiki's geometry — 16rem wide, 14px items, `On this page` at 1.125rem/500 sentence case, 1rem inner padding, 0.75rem between items, 12px indentation per level. The active entry is the only emphasized one (text color, weight 500); every other entry stays muted, so moving between sections at the same level is visible. `--font-sans`/`--font-mono` become system stacks. Sidebar labels derived from paths are Title Cased so they sit beside authored titles; authored titles are never rewritten.

- Alternatives considered: shipping Geist (a dependency and assets for a self-hosted LAN surface; deferred, not foreclosed).

### Custom Mariana Shiki theme for dark; github-light stays for light

Shiki's `themes` option already takes light/dark pairs; dark becomes a small custom theme registered from Mariana's own `.sublime-color-scheme` variables (comment `#a6acb9`, string mint `#99c794`, number orange `#f9ae58`, keyword pink `#c695c6`, storage red `#ec5f66`, function teal `#5fb3b3`, types blue `#6699cc`). Light keeps `github-light` on our `#f1f1f1` block.

- Alternatives considered: nearest built-in dark theme (no Mariana equivalent exists; the mismatch is the reason for choosing Mariana); importing the full scheme file (the subset covers every scope our lang set emits).

### Mermaid uses the base theme with our variables

The bootstrap reads `data-theme` plus `prefers-color-scheme` for the effective theme and calls Mermaid with `theme: "base"` and a compact `themeVariables` set (background transparent, line, text, node fills, font family) for both palettes.

- Alternatives considered: Mermaid's built-in `dark` theme (its palette is unrelated to ours); re-rendering on toggle (impossible without a script; the redirect reload makes it unnecessary).

### Outline scroll-spy is progressive enhancement

A ~12-line inline script ships only on pages whose outline is non-empty: it maps the outline links to their headings and, on a rAF-throttled `scroll`, marks the last heading whose top has passed the topbar line with `aria-current="location"` on the matching link. Without scripting the outline renders and links unchanged; pages without an outline still ship no script.

- Alternatives considered: `IntersectionObserver` (needs "last heading seen" state for headings leaving its band — more code for no gain at this scale); CSS scroll-driven animations (cannot attribute another element's position to a nav link); no script at all (leaves the rail static).
- Cost accepted: `/wiki` gains a second conditional script; the theme, the rails' collapse, and all content remain script-independent.

### Scope and plumbing

Only `/wiki/*` changes; the cookie's `Path=/wiki` enforces it. The token and theme query params are handled in one place so both cookies can be set in a single redirect; unrecognized theme values are ignored but still redirect cleanly.

## Risks / Trade-offs

- [Warm light / cool dark mode mismatch] → Accepted; each mode is internally coherent, and many products pair a paper light with a slate dark.
- [Custom Shiki theme drifts from real Mariana] → It maps the variables the scheme itself defines, and lives next to the renderer with a unit test on emitted palette values.
- [Reload per theme change] → Accepted, and it keeps diagrams and code re-rendered consistently; the zero-JS property is worth more on a LAN read surface.

## Migration Plan

None: presentation and routing only, no data or API change. Rollback is reverting the code.

## Open Questions

None.
