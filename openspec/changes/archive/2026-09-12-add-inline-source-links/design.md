## Context

See proposal.md — Why. The body of a generated page references code as inline
code spans (`` `goal.ts:633-661` ``); the renderer's `code_inline` rule currently
emits `<code>…</code>` unconditionally (`wikiRender.ts`), and only frontmatter
`sources` carry the citation metadata the Sources footer uses. The checkout
(`repo.clonePath`) is on disk next to the page and `webSourceUrl` already maps
`source` + `lastIndexedSha` + path + range to a forge permalink. The observed
production page (opencode-goal, `architecture/continuation-mechanism.md`) has
eight `goal.ts:<range>` mentions, only some of which match a frontmatter source
entry's range exactly — so frontmatter cannot be the linkability test.

## Goals / Non-Goals

**Goals:**
- The exact mention a reader sees becomes the link, at the range written in the
  text, when the file is real and the forge location is derivable.
- Rendering stays synchronous and offline; resolution costs one stat per unique
  mention per page.

**Non-Goals:**
- Any new config, provider, or URL shape (reuse `webSourceUrl`).
- Touching fenced code, prose, or existing Sources rendering.

## Decisions

### Link inline code spans only, and only when they carry a line range
The producers write code references as backticks, and a bare path-like span
(`package.json`, `tsconfig.json`) is indistinguishable from ordinary prose, so
the range is the citation signal. Both produced grammars are accepted —
`path:start-end` / `path:start` and `path#Lstart-Lend` / `path#Lstart`
(observed on different pages of the same bundle). Alternatives considered:
rewriting plain text tokens (invents links mid-sentence and cannot be undone by
the author); linking all path-like spans (directory listings and config
mentions become noise).

### Linkability = the path exists in the checkout
A mention is linked only when `resolve(checkout, path)` stays inside the
checkout and `stat`s as a file. This rejects references to other repositories,
dependency internals, and typos without a database read. Alternatives
considered: matching frontmatter `sources` (rejects real mentions whose range
differs from the source entry — the observed page cites `goal.ts:389-409`
under `repo://goal.ts#L378-L409`); checking the index (excludes files kept out
by exclude globs); no check (dead links).

### Resolve once per page in `wiki.ts`, substitute in the renderer
`inlineSourceLinks(body, repo)` scans the raw body for code spans matching the
citation grammar, deduplicates by raw text, validates, and returns
`Map<raw, href>`; `RenderEnv` carries it and the `code_inline` rule swaps in the
anchor. Alternatives considered: an async resolver inside the rule (markdown-it
renderers are synchronous); resolving on every render without a map (repeated
stats, no dedupe).

### Keep the anchor wrapping the original text
The output is `<a href="…"><code>goal.ts:633-661</code></a>` — the reader sees
the same text, now clickable; no rewriting of what the producer wrote.
Alternative considered: appending an icon or shortening the text (changes
generated content in ways the producer did not write).

## Risks / Trade-offs

- [A real file cited with a shorthand path (`goal.ts` for `src/goal.ts`) gets no
  link] → conservative by design; a wrong link is worse than plain text.
- [Mentions inside fenced blocks are validated into the map but never looked
  up] → harmless; work is bounded by page size and the map is keyed by raw text.
- [Generated content with `path:range` that is not a citation links anyway] →
  the checkout existence check makes that a real file, so the link is still
  correct.

## Migration Plan

Read-time only; no state changes. Restart `serve` (or the dev process) to pick
up the renderer.
