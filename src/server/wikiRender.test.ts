import { describe, expect, test } from "bun:test";
import { createWikiMarkdown, hasMermaidDiagram, type RenderEnv } from "./wikiRender.ts";

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
