## 1. Skill content

- [x] 1.1 Add a "Diagrams" section to [SKILL.md](../../../src/producer/skill/skills/okf-wiki/SKILL.md) instructing: `flowchart TD` for component/module relationships and decision points with multiple outcomes, `sequenceDiagram` for interactions over time, one caption sentence after every diagram, and no diagram on pure-reference or single-linear-path pages. Verify by re-reading the rendered section against each of the four spec scenarios in `specs/okf-producer/spec.md`.

## 2. Tests

- [x] 2.1 In `src/producer/claude.test.ts`, extend the `authoringPrompt()` coverage with assertions that the returned string contains the `flowchart TD` guidance, the `sequenceDiagram` guidance, the caption instruction, and the skip-diagrams-on-reference-pages instruction — one assertion per spec scenario. Verify with `bun test src/producer/claude.test.ts`.
- [x] 2.2 In `test/spike/claudeProducer.spike.test.ts` (live, gated behind `ODW_SPIKE=1`), add a test asserting the real produced bundle contains at least one page with a Mermaid fence — the fixture's tiny layered module graph (`cache.ts` → `store.ts` → `index.ts`) is exactly the "component relationship" case the new guidance targets, so this checks the model actually follows the instruction, not just that the prompt asks for it. Verify with `ODW_SPIKE=1 bun test test/spike/` (costs real quota — run only when explicitly requested).

## 3. Verification

- [x] 3.1 Run the full producer test suite and typecheck to confirm no other producer behavior changed: `bun test src/producer` and `tsc --noEmit`.
