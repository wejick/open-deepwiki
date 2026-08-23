## 1. Wiki deep-link bootstrap

- [x] 1.1 Widen the bootstrap branch in `handleWiki` (src/server/wiki.ts) to accept `?token=` on any `/wiki*` path: validate when `requiresToken`, set the same cookie, redirect to the same pathname without the query; bare `/wiki` behavior unchanged. Tests in wiki.test.ts: deep link with valid token → Set-Cookie + clean 302; wrong token on LAN bind → 401, no cookie; localhost bind → redirect without validation.

## 2. Dashboard wiki link

- [x] 2.1 Add exported pure helper `wikiHref(repoId, wikiCount, token)` to src/server/dashboard.js returning `/wiki/<id>?token=<enc>` / `/wiki/<id>` / null (plain text) per the dashboard spec scenarios. Unit tests in dashboard.test.ts cover all three branches.
- [x] 2.2 Render the repo cell through `wikiHref` in `renderRepoRows` (anchor when it returns a URL, plain text otherwise) and rewrite rendered wiki links on the token input's `change` event. Tests: row with wiki docs renders an anchor; zero-docs row renders plain text; token typed after render updates hrefs without refresh.

## 3. Validation

- [x] 3.1 `bun test ./src ./test`, `bun run lint`, `bun run typecheck` all pass; `openspec validate --changes` passes for this change.
