import { describe, expect, test } from "bun:test";
import {
  createWikiMarkdown,
  hasMermaidDiagram,
  parseInlineCitation,
  slugifyHeading,
  type RenderEnv,
} from "./wikiRender.ts";

function env(overrides: Partial<RenderEnv> = {}): RenderEnv {
  return { repoId: "testrepo", fromDir: "", conceptIds: new Set(), ...overrides };
}

describe("hasMermaidDiagram", () => {
  test("true when the rendered fragment has a mermaid block", () => {
    expect(hasMermaidDiagram('<pre class="mermaid">flowchart TD</pre>')).toBe(true);
  });

  test("false otherwise", () => {
    expect(hasMermaidDiagram("<p>no diagram here</p>")).toBe(false);
  });
});

describe("code block highlighted", () => {
  test("a tagged fence is rendered through Shiki, not a plain <pre><code>", async () => {
    const md = await createWikiMarkdown();
    const html = md.render("```ts\nconst x = 1;\n```\n", env());
    expect(html).toContain("shiki");
    expect(html).not.toContain("<pre><code");
  });

  test("an unrecognized language falls back instead of throwing", async () => {
    const md = await createWikiMarkdown();
    const html = md.render("```not-a-real-lang\nhello\n```\n", env());
    expect(html).toContain("shiki");
  });
});

describe("Mermaid block rendered as a diagram", () => {
  test("mermaid fence is passed through raw, not highlighted", async () => {
    const md = await createWikiMarkdown();
    const html = md.render("```mermaid\nflowchart TD\n  A --> B\n```\n", env());
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain("flowchart TD");
    expect(html).not.toContain("shiki");
  });
});

describe("Heading anchors and outline", () => {
  test("heading ids emitted and outline collected in document order", async () => {
    const md = await createWikiMarkdown();
    const e = env({ outline: [] });
    const html = md.render("# Intro\n\n## Details\n", e);
    expect(html).toContain('<h1 id="intro">');
    expect(html).toContain('<h2 id="details">');
    expect(e.outline).toEqual([
      { level: 1, text: "Intro", id: "intro" },
      { level: 2, text: "Details", id: "details" },
    ]);
  });

  test("Duplicate headings get distinct ids", async () => {
    const md = await createWikiMarkdown();
    const e = env({ outline: [] });
    const html = md.render("## Notes\n\n## Notes\n", e);
    expect(html).toContain('<h2 id="notes">');
    expect(html).toContain('<h2 id="notes-1">');
    expect(e.outline?.map((o) => o.id)).toEqual(["notes", "notes-1"]);
  });

  test("Page without headings collects nothing", async () => {
    const md = await createWikiMarkdown();
    const e = env({ outline: [] });
    const html = md.render("Just a paragraph.\n", e);
    expect(e.outline).toEqual([]);
    expect(html).not.toContain("id=");
  });

  test("slug drops punctuation and inline-code syntax", async () => {
    expect(slugifyHeading("CLI entrypoint: `run()` & flags")).toBe("cli-entrypoint-run-flags");
  });
});

describe("Cross-page link resolution", () => {
  test("relative concept link resolved to /wiki/<repoId>/<id>", async () => {
    const md = await createWikiMarkdown();
    const html = md.render("[Two modes](../concepts/two-modes.md)\n", {
      repoId: "testrepo",
      fromDir: "architecture",
      conceptIds: new Set(["concepts/two-modes"]),
    });
    expect(html).toContain('href="/wiki/testrepo/concepts/two-modes"');
  });

  test("bundle-root-absolute concept link resolved", async () => {
    const md = await createWikiMarkdown();
    const html = md.render("[Overview](/openwiki/architecture/overview.md)\n", {
      repoId: "testrepo",
      fromDir: "concepts",
      conceptIds: new Set(["architecture/overview"]),
    });
    expect(html).toContain('href="/wiki/testrepo/architecture/overview"');
  });

  test("directory link (no .md target) rewritten to the directory listing", async () => {
    const md = await createWikiMarkdown();
    const html = md.render("[architecture](architecture/)\n", env());
    expect(html).toContain('href="/wiki/testrepo/architecture"');
  });

  test("a relative non-.md, non-directory link (e.g. a source file) is left untouched", async () => {
    // Only a trailing slash signals "this is a directory reference" — a
    // relative link to some other non-page file shouldn't be rewritten into
    // a synthesized /wiki/... URL that's no more likely to resolve than the
    // original.
    const md = await createWikiMarkdown();
    const html = md.render("[config](../config.yaml)\n", env());
    expect(html).toContain('href="../config.yaml"');
  });

  test("external link left untouched", async () => {
    const md = await createWikiMarkdown();
    const html = md.render("[ext](https://example.com/x)\n", env());
    expect(html).toContain('href="https://example.com/x"');
  });

  test("unresolved .md link (not a known concept) left untouched", async () => {
    const md = await createWikiMarkdown();
    const html = md.render("[missing](nope.md)\n", env());
    expect(html).toContain('href="nope.md"');
  });
});

describe("parseInlineCitation", () => {
  test("ranged mention", () => {
    expect(parseInlineCitation("goal.ts:633-661")).toEqual({
      path: "goal.ts",
      range: { start: 633, end: 661 },
    });
  });

  test("single-line mention", () => {
    expect(parseInlineCitation("src/auth.ts:8")).toEqual({
      path: "src/auth.ts",
      range: { start: 8, end: 8 },
    });
  });

  test("hash-form mention", () => {
    expect(parseInlineCitation("goal.ts#L71-L86")).toEqual({
      path: "goal.ts",
      range: { start: 71, end: 86 },
    });
    expect(parseInlineCitation("goal.ts#L20")).toEqual({
      path: "goal.ts",
      range: { start: 20, end: 20 },
    });
  });

  test("non-citations are null", () => {
    expect(parseInlineCitation("session.execution.succeeded")).toBeNull();
    expect(parseInlineCitation("package.json")).toBeNull();
    expect(parseInlineCitation("https://github.com/x/y.ts:3")).toBeNull();
    expect(parseInlineCitation("not-a-path:1-2")).toBeNull();
  });
});

describe("Inline source citations linked", () => {
  test("a mapped mention renders as an anchor around its code", async () => {
    const md = await createWikiMarkdown();
    const html = md.render("Hook (`goal.ts:633-661`) runs.\n", {
      ...env(),
      sourceLinks: new Map([
        ["goal.ts:633-661", "https://github.com/team/repo/blob/abc/goal.ts#L633-L661"],
      ]),
    });
    expect(html).toContain(
      '<a href="https://github.com/team/repo/blob/abc/goal.ts#L633-L661"><code>goal.ts:633-661</code></a>',
    );
  });

  test("without a map entry the span stays plain code", async () => {
    const md = await createWikiMarkdown();
    const html = md.render("Hook (`goal.ts:633-661`) runs.\n", env());
    expect(html).toContain("<code>goal.ts:633-661</code>");
    expect(html).not.toContain("<a ");
  });

  test("a fenced block is never linked, map or not", async () => {
    const md = await createWikiMarkdown();
    const html = md.render("```\ngoal.ts:633-661\n```\n", {
      ...env(),
      sourceLinks: new Map([
        ["goal.ts:633-661", "https://github.com/team/repo/blob/abc/goal.ts#L633-L661"],
      ]),
    });
    expect(html).not.toContain("<a ");
  });
});
