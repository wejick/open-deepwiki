## Why

Wiki pages cite the repository files they describe — frontmatter `sources: [{resource: "repo://src/auth.ts#L10-L20"}]` — but the `/wiki` viewer renders only the page body, so those citations are invisible in the browser; and `ask_repo` / `search_code` return `path` + `lineRanges` with no clickable destination. A reader cannot jump from a claim to the code it cites, even though the registry already holds the clone source and the indexed commit that make a forge permalink derivable.

## What Changes

- Add a pure `webSourceUrl(source, sha, path, range)` helper: scp-like / ssh / https remote + indexed SHA + repo-relative path → forge permalink. GitHub uses `/blob/<sha>/<path>#L10-L20`; GitLab uses `/-/blob/<sha>/<path>#L10-20`; a single-line range emits `#L<n>`; a file citation with no range has no fragment.
- Infer the provider from the source host (`gitlab` in host → GitLab, `github` → GitHub). Local paths, unrecognized hosts, and unindexed repos yield no link.
- `/wiki` concept pages render a **Sources** section from frontmatter `sources`: each `repo://` entry links to the forge at `lastIndexedSha` when derivable, and otherwise renders as plain `path:start-end` text.
- `ask_repo` / `search_code` source-kind results gain a `url` field under the same rules (null when not derivable); wiki-kind results are unchanged.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `wiki-viewer`: new requirement to render page sources with forge links.
- `mcp-server`: new requirement attaching a forge `url` to source-kind search results.

## Impact

`src/repoManager` (remote → web helper), `src/server/wiki.ts` (Sources section), `src/server/tools.ts` (search payloads), plus their tests and a fixture page carrying `sources` frontmatter. No database, registry schema, config, or dependency changes. `/wiki` auth and routing and `get_wiki_page`'s verbatim contract are untouched.

## Non-goals

- Linking code fences, prose mentions, or `repo://` body links — no producer emits body links, and fences carry no file provenance.
- A per-repo web base override, and forge shapes beyond GitHub/GitLab (Bitbucket, Azure DevOps, Gitea).
- Changing `get_wiki_page`'s verbatim response or its identity header.
