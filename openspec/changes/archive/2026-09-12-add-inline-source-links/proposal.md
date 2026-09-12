## Why

The `add-forge-source-links` change links a page's frontmatter citations in a **Sources** footer, but the page body's actual references — inline code spans like `` `goal.ts:633-661` `` — stay dead text, so a reader following the prose still cannot jump to the cited lines. The mentions are already precise (repo file + line range) and the registry already holds the source and indexed revision, so the link is derivable at render time.

## What Changes

- Inline code spans naming a repository file and line range (`path:start-end`, `path:start`, `path#Lstart-Lend`, `path#Lstart`) render as links to that file's forge location at `lastIndexedSha` when the path exists in the checkout and a web location is derivable; otherwise they render unchanged.
- Per page, the body's mentions are collected, deduplicated, checked against the checkout, and mapped to URLs once; the markdown renderer substitutes from that map.
- The mention's own line range drives the fragment — not the page's frontmatter `sources`.
- The Sources footer is unchanged; the two views coexist.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `wiki-viewer`: new requirement linking inline source citations in the page body.

## Impact

`src/server/wiki.ts` (mention resolver + render env), `src/server/wikiRender.ts` (citation parser + inline-code renderer), and their tests plus the `sourced` fixture body. No database, registry, config, or dependency changes. Fenced code, cross-page links, the Sources footer, and MCP output are untouched.

## Non-goals

- Linkifying plain prose text, paths without a line range, or fenced code blocks.
- Using the index or frontmatter to decide linkability instead of the checkout.
- Changing MCP tool output or the Sources footer.
