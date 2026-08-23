import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  degradeInvalidMermaidFences,
  extractMermaidFences,
  finalizeClaudeBundle,
  findInvalidMermaidFences,
  loadMermaid,
  syncIndexes,
} from "./claudeFinalize.ts";
import { makeTmp, rmTmp } from "../../test/helpers/tmp.ts";

let tmpDirs: string[] = [];
async function bundle(): Promise<string> {
  const dir = await makeTmp();
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
});

const page = (type: string, title: string, description: string, body = "Body."): string =>
  `---\ntype: ${type}\ntitle: ${title}\ndescription: ${description}\n---\n\n# ${title}\n\n${body}\n`;

describe("Claude producer bundle finalization › index synchronization", () => {
  test("regenerates a directory with existing hand-authored content", async () => {
    const dir = await bundle();
    await Bun.write(join(dir, "index.md"), "stale content that does not match reality\n");
    await Bun.write(join(dir, "overview.md"), page("overview", "Overview", "Top-level map"));
    await Bun.write(join(dir, "guide.md"), page("guide", "Guide", "How to use it"));

    await syncIndexes(dir);

    const index = await readFile(join(dir, "index.md"), "utf8");
    expect(index).toContain("[Guide](guide.md) - How to use it");
    expect(index).toContain("[Overview](overview.md) - Top-level map");
    // Sorted by href: guide.md before overview.md.
    expect(index.indexOf("guide.md")).toBeLessThan(index.indexOf("overview.md"));
  });

  test("regenerates a directory with a missing index.md", async () => {
    const dir = await bundle();
    await Bun.write(join(dir, "solo.md"), page("solo", "Solo", "Only page"));

    await syncIndexes(dir);

    const index = await readFile(join(dir, "index.md"), "utf8");
    expect(index).toContain("[Solo](solo.md) - Only page");
  });

  test("root index carries the okf_version marker; nested indexes carry none", async () => {
    const dir = await bundle();
    await mkdir(join(dir, "sub"), { recursive: true });
    await Bun.write(join(dir, "root.md"), page("root", "Root", "Root page"));
    await Bun.write(join(dir, "sub", "child.md"), page("child", "Child", "Child page"));

    await syncIndexes(dir);

    const rootIndex = await readFile(join(dir, "index.md"), "utf8");
    expect(rootIndex.startsWith('---\nokf_version: "0.2"\n---\n\n')).toBe(true);
    expect(rootIndex).toContain("[sub](sub/)");

    const subIndex = await readFile(join(dir, "sub", "index.md"), "utf8");
    expect(subIndex.startsWith("---")).toBe(false);
    expect(subIndex).toContain("[Child](child.md) - Child page");
  });

  test("a directory with only subdirectories still lists them", async () => {
    const dir = await bundle();
    await mkdir(join(dir, "architecture"), { recursive: true });
    await Bun.write(
      join(dir, "architecture", "overview.md"),
      page("overview", "Overview", "Top map"),
    );

    await syncIndexes(dir);

    const rootIndex = await readFile(join(dir, "index.md"), "utf8");
    expect(rootIndex).not.toContain("# Files");
    expect(rootIndex).toContain("# Directories");
    expect(rootIndex).toContain("[architecture](architecture/)");
  });

  test("a directory name containing a markdown special character is escaped", async () => {
    const dir = await bundle();
    await mkdir(join(dir, "foo]bar"), { recursive: true });
    await Bun.write(join(dir, "foo]bar", "page.md"), page("concept", "Page", "A page"));

    await syncIndexes(dir);

    const rootIndex = await readFile(join(dir, "index.md"), "utf8");
    expect(rootIndex).toContain("[foo\\]bar](foo]bar/)");
  });

  test("a stale index.md is removed once its directory has no pages or subdirectories left", async () => {
    const dir = await bundle();
    await mkdir(join(dir, "empty"), { recursive: true });
    await Bun.write(join(dir, "empty", "index.md"), "stale — the page it listed was deleted\n");

    await syncIndexes(dir);

    await expect(readFile(join(dir, "empty", "index.md"), "utf8")).rejects.toThrow();
  });
});

const VALID_FLOWCHART =
  'flowchart TD\n  A["cli entrypoint"] --> B["parseCommand"]\n  B --> C{"decision"}\n  C -->|yes| D["Yes"]\n  C -->|no| E["No"]\n';
const VALID_SEQUENCE =
  "sequenceDiagram\n  participant A\n  participant B\n  A->>B: hello\n  B-->>A: hi\n";
const BROKEN_DIAGRAM = "flowchart TD\n  this is not valid <<< mermaid ; syntax\n";

describe("Mermaid validation", () => {
  test("loadMermaid is idempotent and never leaves its DOM shim on globalThis", async () => {
    const hadWindow = Object.hasOwn(globalThis, "window");
    const hadDocument = Object.hasOwn(globalThis, "document");

    const a = await loadMermaid();
    const b = await loadMermaid();
    expect(a).toBe(b);

    // The shim exists only for the duration of each call that needs it — this
    // runs inside a shared `bun test` process alongside code (e.g.
    // dashboard.js) that assumes no DOM exists.
    expect(Object.hasOwn(globalThis, "window")).toBe(hadWindow);
    expect(Object.hasOwn(globalThis, "document")).toBe(hadDocument);
  });

  test("extractMermaidFences tracks generic fences without mistaking them for real diagrams", () => {
    const md = "````markdown\n```mermaid\nnot a real diagram, just an example\n```\n````\n";
    expect(extractMermaidFences(md)).toEqual([]);
  });

  test("a valid flowchart and a valid sequence diagram both pass", async () => {
    const md = `# Page\n\n\`\`\`mermaid\n${VALID_FLOWCHART}\`\`\`\n\nCaption.\n\n\`\`\`mermaid\n${VALID_SEQUENCE}\`\`\`\n\nCaption.\n`;
    expect(await findInvalidMermaidFences(md)).toEqual([]);
  });

  test("a syntactically broken diagram is flagged", async () => {
    const md = `# Page\n\n\`\`\`mermaid\n${BROKEN_DIAGRAM}\`\`\`\n`;
    const invalid = await findInvalidMermaidFences(md);
    expect(invalid).toHaveLength(1);
  });

  test("parsing a fence never leaves the DOM shim on globalThis afterward", async () => {
    const hadWindow = Object.hasOwn(globalThis, "window");
    const hadDocument = Object.hasOwn(globalThis, "document");

    await findInvalidMermaidFences(`# Page\n\n\`\`\`mermaid\n${VALID_FLOWCHART}\`\`\`\n`);

    expect(Object.hasOwn(globalThis, "window")).toBe(hadWindow);
    expect(Object.hasOwn(globalThis, "document")).toBe(hadDocument);
  });

  test("a fence with no issues is untouched", async () => {
    const md = `# Page\n\n\`\`\`mermaid\n${VALID_FLOWCHART}\`\`\`\n`;
    expect(await degradeInvalidMermaidFences(md)).toBe(md);
  });
});

describe("Mermaid degrade", () => {
  test("a single invalid fence is degraded to text with a comment", async () => {
    const md = `# Page\n\n\`\`\`mermaid\n${BROKEN_DIAGRAM}\`\`\`\n\nAfter.\n`;
    const out = await degradeInvalidMermaidFences(md);
    expect(out).toContain("<!-- claude producer: mermaid parse failed, degraded to text -->");
    expect(out).toContain("```text");
    expect(out).toContain(BROKEN_DIAGRAM.trim());
    expect(out).not.toContain("```mermaid");
    expect(out).toContain("After.");
  });

  test("multiple fences handled independently, only invalid ones rewritten", async () => {
    const md = `# Page\n\n\`\`\`mermaid\n${VALID_FLOWCHART}\`\`\`\n\nMiddle.\n\n\`\`\`mermaid\n${BROKEN_DIAGRAM}\`\`\`\n\nEnd.\n`;
    const out = await degradeInvalidMermaidFences(md);
    expect(out).toContain("```mermaid"); // the valid one survives
    expect(out).toContain("```text"); // the broken one is degraded
    expect(out).toContain(VALID_FLOWCHART.trim());
    expect(out).toContain("Middle.");
    expect(out).toContain("End.");
  });

  test("a document with no invalid fences is returned unchanged", async () => {
    const md = `# Page\n\n\`\`\`mermaid\n${VALID_SEQUENCE}\`\`\`\n`;
    expect(await degradeInvalidMermaidFences(md)).toBe(md);
  });

  test("concurrent parses (as from two repos' runs overlapping) never corrupt each other", async () => {
    // Regression: an earlier version installed the DOM shim without a mutex,
    // so an in-flight parse from one call could be torn down mid-flight by
    // another's `finally`. Runs many overlapping calls against documents that
    // MUST resolve differently to catch any cross-contamination.
    const validMd = `# Page\n\n\`\`\`mermaid\n${VALID_FLOWCHART}\`\`\`\n`;
    const brokenMd = `# Page\n\n\`\`\`mermaid\n${BROKEN_DIAGRAM}\`\`\`\n`;
    const calls = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0 ? findInvalidMermaidFences(validMd) : findInvalidMermaidFences(brokenMd),
    );
    const results = await Promise.all(calls);
    results.forEach((invalid, i) => {
      expect(invalid).toHaveLength(i % 2 === 0 ? 0 : 1);
    });
  });
});

describe("Claude producer bundle finalization › reserved files are exempt", () => {
  test("a broken Mermaid fence inside log.md is left untouched", async () => {
    const dir = await bundle();
    await Bun.write(join(dir, "concept.md"), page("concept", "Concept", "A page"));
    const logContent = `# Log\n\n\`\`\`mermaid\n${BROKEN_DIAGRAM}\`\`\`\n`;
    await Bun.write(join(dir, "log.md"), logContent);

    await finalizeClaudeBundle(dir);

    expect(await readFile(join(dir, "log.md"), "utf8")).toBe(logContent);
  });
});
