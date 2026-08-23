## 1. Non-documentable file filter and digest

- [x] 1.1 Add an `isNonDocumentable(path)` predicate and `listDocumentableFiles(cwd)` in `src/producer/claudeDigest.ts` (tracked files minus non-documentable), covering: media/binary extensions; lockfile basenames; `.strings`/`.po`/`.pot` catalogs and `*/strings/*.json|xml`; `node_modules`/`Pods`/`DerivedData`/`.gradle` path segments; `.lottie` and `assets/animations/*.json`. Verify with a unit test that classifies one file per kind as excluded and plain source as kept.
- [x] 1.2 Make `repoDigest` group and count only documentable files and report exclusions in its header (documentable count, excluded total, per-kind counts). Verify with updated `claudeDigest.test.ts` fixtures: a tree mixing code with one file of each excluded kind digests without them and states the exclusion report; existing grouping/determinism/maxDirs/empty-repo tests still pass with the new header wording.
- [x] 1.3 Verify digest byte/count grouping ignores excluded files (an assets-heavy directory shows only its documentable files) in the same test file.

## 2. Sizing and call-site plumbing

- [x] 2.1 In `src/producer/claude.ts`, source the init-planning branch's file list (`splitPlanFiles` threshold, digest input, and the list handed to `mapDirectives` and `validateMap`) from `listDocumentableFiles` instead of `listTrackedFiles`. Verify `claude.test.ts` still exercises split planning and validation with no other change.
- [x] 2.2 Update `mapDirectives` wording: the digest is "the documentable file tree" and the directive covers the digest-listed documentable count, not "tracked files"; keep the budget/expected-count arithmetic on N. Verify the "The map session is told the digest, the sizing, and where to write" test asserts the documentable wording.
- [x] 2.3 Add a test where the checkout contains git-tracked media/lockfile/string files so the raw tracked count exceeds the split threshold but the documentable count does not, and verify planning stays single-session and the sizing phrasing uses the documentable count.

## 3. Map ownership guidance (MAP.md)

- [x] 3.1 Rewrite the "Areas" section of `src/producer/skill/skills/okf-wiki/MAP.md`: areas are overlapping scopes (a file may belong to several), the map owns only digest-listed files, omitted kinds need no owner and must not get an area or a `path` into an omitted subtree, and areas are named for flows/modules rather than file-kind directories.
- [x] 3.2 Add a "Verify before you write" section to `MAP.md`: total each area's files from the digest and split any area over budget; confirm every top-level code group the digest lists is reached by at least one area; do not assert coverage in the closing summary.
- [x] 3.3 Add a `claude.test.ts` group that reads the stripped `MAP.md` body and asserts each ownership-guidance scenario (overlap permitted, no strict-partition demand, omitted files refused areas, flows over stubs, pre-write budget check, code-group reach, no coverage claims in the summary).

## 4. Consistency and validation

- [x] 4.1 Grep for stale "tracked file"/"exactly one area"/"must cover the tree" phrasing in `MAP.md`, `mapDirectives`, and digest headers; reconcile every occurrence with the new set-based framing.
- [x] 4.2 Run `bun test ./src ./test`, `bun run lint`, `bun run format`, `bun run typecheck`, and `openspec validate --specs`; fix any failures and confirm the full suite is green.
