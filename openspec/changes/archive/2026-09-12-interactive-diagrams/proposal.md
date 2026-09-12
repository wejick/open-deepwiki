## Why

Mermaid diagrams render as static SVGs: a wide or dense flowchart is unreadable at content width and cannot be inspected. DeepWiki's diagrams are interactive — pointer-drag panning, wheel zoom, and Zoom in/out controls, implemented by manipulating the SVG `viewBox` with no extra dependency. We adopt the same interaction on the existing diagram bootstrap.

## What Changes

- Inline diagrams stay static: the diagram card (slim border, pointer cursor, hover border emphasis) opens on click, Enter/Space, or its Expand control — no inline pan or zoom, so the wheel never fights page scrolling.
- Expanding opens a centered popup at 90% viewport width and height (DeepWiki's dialog geometry, not fullscreen), containing a cloned SVG with pointer-drag panning, wheel zoom at the pointer, Zoom in / Zoom out controls, and Close (also Escape or a click outside).
- Zoom rates follow the proven reference: a fixed 1.06× per wheel event and 1.2× per button click (DeepWiki's values; svg-pan-zoom, panzoom, OpenSeadragon and d3-zoom sit in the same 1.06–1.3 band), bounded to 0.2×–5×.
- All of it lives in the existing conditional Mermaid bootstrap — pages without diagrams still ship no script, and no new dependency or asset route is introduced.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wiki-viewer`: new requirement for interactive diagrams.

## Non-goals

- Inline pan or zoom, download/reset/fit controls, or touch pinch beyond native pointer/wheel behavior.
- New libraries (panzoom, svg-pan-zoom) or a separate client bundle.

## Impact

- `src/server/wiki.ts` — the Mermaid bootstrap and the diagram styles.
- `src/server/wiki.test.ts` — viewer hooks on diagram pages, unchanged script-free non-diagram pages.
- Spec: `openspec/specs/wiki-viewer/spec.md` (via delta).
