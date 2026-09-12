## Context

See proposal.md — Why. Current state that shapes the approach:

- `MERMAID_BOOTSTRAP` (`src/server/wiki.ts`) is a const module script included only when `hasMermaidDiagram(page.html)`; it initializes Mermaid with theme variables and runs it over `pre.mermaid`.
- Mermaid v11 emits an `<svg>` with a `viewBox`, intrinsic aspect ratio, and an inline `max-width`; `mermaid.run` resolves when rendering finishes, so the bootstrap can `await` it before touching the DOM.
- DeepWiki's shipped viewer (chunk `6063-…js`) is the reference: the inline diagram is a `cursor-pointer` card that opens a Radix dialog on click; the wheel handler is gated to the popup (`if (!isPopup) return`) and steps `1.06^±1` per event; the dialog is `90vw × 90vh` (`max-w-[90vw]`, `h-[90vh]`); buttons step `1.2`.
- Standard wheel-zoom rates sit in the same band: svg-pan-zoom's `zoomScaleSensitivity` 0.2, `@panzoom/panzoom`'s `step` 0.3, OpenSeadragon's `zoomPerScroll` 1.2, d3-zoom's default ≈`2^(−0.2)` (~13%) per 100px wheel notch.
- Server tests assert script and markup substrings; there is no browser, so interaction behavior itself is out of test reach.

## Goals / Non-Goals

**Goals**

- Inline diagrams stay static and legible; click (or Enter/Space, or the Expand control) opens a centered popup with pan, wheel zoom, and Zoom in/out.
- Zoom feel matches a proven reference (DeepWiki's 1.06 wheel step, 1.2 buttons).
- Pages without diagrams stay script-free, and no new dependency or asset route is introduced.

**Non-Goals**

- Inline pan/zoom (the earlier iteration had it; it fights page scrolling and click-to-expand).
- Fullscreen, download, reset, or fit-to-width controls.
- Touch pinch gestures beyond what pointer events and wheel naturally give.

## Decisions

### Inline diagrams expand on click; zoom lives only in the popup

The inline `pre.mermaid` becomes a `role="button"`, `tabindex="0"` card with a slim border, a pointer cursor, and a hover border emphasis. The border — not a background fill — carries the hover cue, because the Mermaid node fill matches our hover surface (`#e8e8e8` light, `#414850` dark) and nodes became unreadable under a background hover. Click, Enter/Space, or the hover-revealed Expand control calls `expand(svg)`. No pointer or wheel listeners are attached inline, so dragging does not pan and the wheel does not zoom or fight page scrolling. DeepWiki gates its wheel handler to the popup the same way; we go one step further and remove inline pan too.

- Alternatives considered: inline wheel/pan with hover zoom buttons (the previous iteration — wheel hijack makes the diagram a scroll trap, and every click risks expanding mid-drag); a separate "open" link below the diagram (less discoverable, more markup).

### Popup is a 90vw × 90vh centered `<dialog>` with a cloned SVG

`expand` appends `<dialog class="diagram-modal">`, clones the SVG into a full-size stage, clears Mermaid's sizing, shows the modal, then wires the viewer to the clone. The dialog is `90vw × 90vh`, rounded, bordered, on a dimmed backdrop — DeepWiki's exact dialog geometry, and not edge-to-edge fullscreen. Escape, Close, and a backdrop click close it; the `close` event removes the dialog and restores body scroll. Cloning keeps the inline diagram untouched.

- Alternatives considered: our previous 100vw × 100vh overlay (rejected by review); sizing to the content column's 42rem (too small to be worth expanding); moving the original SVG (the inline view loses its content).

### Viewer: fixed per-event wheel step, buttons at 1.2

The popup clone gets pointer-down/move/up panning (client coordinates, pointer capture, grab/grabbing cursor) and a non-passive wheel handler that steps `1.06^±1` per event, centered from `event.clientX/clientY` against the SVG's rect. This is DeepWiki's exact rate and coordinate handling; a proportional factor under-zooms on trackpads because their per-event deltas are small, which is why the previous `exp(delta·k)` felt slow. Buttons step 1.2, also DeepWiki's.

- Alternatives considered: `Math.exp(delta · 0.0015)` (the previous iteration; trackpad flicks barely move); a fixed 1.2 per wheel event (the iteration before that; a trackpad gesture then explodes); `offsetX`/`offsetY` (relative to the event target — an SVG child — which makes the diagram jump).

### Bounds and cursor states

Zoom is clamped to 0.2×–5× of the diagram's natural `viewBox`; pan is unclamped, so a dragged diagram may show whitespace. Inline uses `cursor: pointer`; the popup uses `grab`/`grabbing`.

- Alternatives considered: unbounded zoom (an accidental spin loses the diagram); pan clamping (bookkeeping DeepWiki does not do).

## Risks / Trade-offs

- [Popup clone duplicates a large SVG] → One clone per expanded diagram, removed on close; negligible for wiki diagrams.
- [The viewer is untested in `bun:test`] → Presence and hooks are asserted server-side; the interaction itself is the same class of browser-only behavior as the existing Mermaid render.
- [Inline diagrams look clickable but do nothing without JS] → Mermaid itself requires JS, so a diagram never renders without it.

## Migration Plan

None: client-side enhancement only. Rollback is reverting the bootstrap and styles.

## Open Questions

None.
