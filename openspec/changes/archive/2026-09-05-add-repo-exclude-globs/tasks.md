# Tasks: add-repo-exclude-globs

## 1. Registry field and resolution

- [x] 1.1 Add optional `excludeGlobs?: string[]` to `RepoConfig` in `src/repoManager/registry.ts`: parsed from `registry.yaml`, entries trimmed/deduplicated (order preserved), round-tripped by `saveYaml`; add `effectiveExcludes(cfg, repo)` merging global + repo globs (additive) beside `producerFor`. Tests: "Per-repo exclude globs › Repo without excludes is unchanged" (no field → `effectiveExcludes` equals global list) and round-trip parse/save of the field in `registry.test.ts`
- [x] 1.2 Add `repo add --exclude <glob>` (repeatable, comma-separated values split) in the add path, persisted via the existing both-files registration save. Tests: "Per-repo exclude globs › Register repo with excludes" — `repo add --exclude "**/__snapshots__/**" --exclude "**/*.a"` records both globs; duplicate/comma forms collapse to the deduplicated list

## 2. Consumers

- [x] 2.1 Pass the merged `Config` (`{ ...cfg, excludeGlobs: effectiveExcludes(cfg, repo) }`) from `pipeline.ts` into `indexRepo` so the source crawl honors repo globs. Tests: "Raw source ingestion › Repo-excluded files are skipped" — fixture repo with a `*.snap` file not matching global globs registers no chunk for it
- [x] 2.2 Purge-at-update (D3): at `indexRepo` start, delete the repo's `source` chunks whose stored path matches any merged exclude glob (reuse `globMatch` over chunk paths). Tests: "Per-repo exclude globs › Registry edit applies on next run" — index a fixture, extend `excludeGlobs` in the registry, re-run update, assert the newly excluded file's chunks are gone and other chunks are untouched
- [x] 2.3 Query-time honors repo globs: server tool handlers build the merged `Config` from the already-loaded registry record before `lexicalSearch`. Tests: "Lexical search via ripgrep › Repo-excluded files are not searched" — real `rg` against a fixture where only the excluded path matches returns no hit from it; assert the `-g !…` args include the repo glob (shim `rg` argv capture)
- [x] 2.4 Equivalence test: the same fixture path set is excluded by crawl and by rg for a glob list mixing `**/` prefixes, suffixes (`*.a`), and segment patterns (guards D1/D3 divergence risk)

## 3. Admin API and dashboard add path

- [x] 3.1 `POST /api/repos` accepts optional `excludeGlobs: string[]` in `src/server/admin.ts`: validated (array of non-empty trimmed strings, else 400 before pre-flight/registration) and persisted through the registration save. Tests: "Add repository with pre-flight validation › Exclude globs persisted with the registration", "Malformed exclude globs rejected before any work" (non-array, non-string entry, empty-string entry → 400, registry unchanged), "Omitted exclude globs record none" (absent/null/empty array)
- [x] 3.2 Dashboard add form gains an excludes textarea (one glob per line); export pure `parseExcludeGlobs(text)` from `src/server/dashboard.js` (trim, drop empties, dedupe first-occurrence order), wire the submit body to carry `excludeGlobs` only when the parsed list is non-empty, DOM wiring behind the `document` guard. Tests: helper unit tests in `dashboard.test.ts` (blank, whitespace lines, duplicates, ordering) and "Repo management actions › Entered globs are submitted" / "Blank excludes field submits no globs"

## 4. Surface and validation

- [x] 4.1 `repo list` shows comma-joined globs on rows that have them, nothing otherwise. Tests: "Per-repo exclude globs › Excludes visible in listing" and "Repo globs extend, not replace, the global list" — a repo with `ci/**` alongside global `*.lock` excludes both
- [x] 4.2 Full-suite gate: `bun test ./src ./test`, `bun run lint`, `bun run typecheck`, `openspec validate --specs` all pass with no network
