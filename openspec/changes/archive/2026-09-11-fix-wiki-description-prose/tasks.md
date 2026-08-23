## 1. Guidance text

- [x] 1.1 Extend the `description` paragraph in `src/producer/skill/skills/okf-wiki/SKILL.md`: after the write-for-search instruction, add that a description describes the page's subject as natural prose readable as its one-line summary (the field is displayed verbatim in listings and results), and must not describe the page's role in the wiki bundle (entry point, starting point) or tell the reader where to go next. Verify: `bun test src/producer/claude.test.ts` — the "retrieval-oriented descriptions" prompt test fails until the phrases land.

## 2. Overview brief

- [x] 2.1 Reword the synthesized overview brief in `src/producer/claudePlan.ts:144` to content-first language (what the repository is, its major domains, which page covers each) with no "entry point"/"task-routing map" phrasing. Verify: new assertion in `src/producer/claudePlan.test.ts` ("Init always yields an overview page" or adjacent) that the brief names the content job and contains neither "entry point" nor "task-routing".

## 3. Prompt-content tests

- [x] 3.1 Extend `test("Page prompt instructs relationship modeling and retrieval-oriented descriptions")` in `src/producer/claude.test.ts` with the new guidance phrases (subject-describing prose, no wiki-role/where-to-start language), mirroring the new spec scenario "Page prompt instructs subject-describing, non-navigational descriptions". Verify: `bun test src/producer/claude.test.ts`.

## 4. Validation

- [x] 4.1 `openspec validate --specs` passes and the change's delta validates; `bun run lint && bun run format && bun run typecheck` clean; `bun run test` green.
