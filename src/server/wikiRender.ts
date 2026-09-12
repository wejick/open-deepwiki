import MarkdownItCtor from "markdown-it";
import type { Env, MarkdownIt } from "markdown-it";
import { createHighlighter, type Highlighter } from "shiki";
import { joinBundlePath, resolveLink } from "../index/ingest.ts";

/**
 * Markdown → HTML for the wiki viewer (spec: wiki-viewer › Rendered page
 * content, Cross-page link resolution). Built once per process: Shiki
 * grammar/theme loading is real cost, not something to repeat per request.
 */

const SHIKI_THEMES = { light: "github-light", dark: "github-dark" } as const;

const SHIKI_LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "bash",
  "shell",
  "yaml",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "html",
  "css",
  "sql",
  "markdown",
  "dockerfile",
  "diff",
  "toml",
] as const;

let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [SHIKI_THEMES.light, SHIKI_THEMES.dark],
    langs: [...SHIKI_LANGS, "text"],
  });
  return highlighterPromise;
}

export type OutlineEntry = { level: number; text: string; id: string };

export type RenderEnv = Env & {
  /** Registered repoId, used to build rewritten `/wiki/<repoId>/...` links. */
  repoId: string;
  /** Directory of the page being rendered, relative to the bundle root ("" for the root). */
  fromDir: string;
  /** Every concept id in this repo's wiki, for link resolution. */
  conceptIds: Set<string>;
  /** Inline code span text -> forge URL; a matching span renders as a link. */
  sourceLinks?: ReadonlyMap<string, string>;
  /** h1–h3 headings collected while rendering, for the page's outline. */
  outline?: OutlineEntry[];
};

/** Per-render slug collision counts, kept off the serializable env fields. */
const SLUG_COUNTS = Symbol("slugCounts");
type SlugEnv = RenderEnv & { [SLUG_COUNTS]?: Map<string, number> };

/** Lowercase, punctuation-stripped, space-to-hyphen anchor text. */
export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replaceAll('"', "&quot;");
}

const EXTERNAL_HREF_RE = /^[a-z][a-z0-9+.-]*:/i; // scheme:... (http:, https:, mailto:, ...)

/** A body citation: repo-relative `path:start-end`, `path:start`,
 *  `path#Lstart-Lend`, or `path#Lstart` — and nothing else; a bare path-like
 *  span is not enough to claim citation. */
const INLINE_CITATION_RE =
  /^([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)$/;

export function parseInlineCitation(
  text: string,
): { path: string; range: { start: number; end: number } } | null {
  const m = INLINE_CITATION_RE.exec(text);
  if (m === null) return null;
  const startRaw = m[2] ?? m[4];
  if (startRaw === undefined) return null;
  const endRaw = m[3] ?? m[5];
  const start = Number(startRaw);
  const end = endRaw === undefined ? start : Number(endRaw);
  return { path: m[1]!, range: { start, end } };
}

let mdPromise: Promise<MarkdownIt> | null = null;

/** The shared markdown-it instance: Shiki-highlighted code, Mermaid fences
 *  passed through raw for client-side rendering, and wiki-aware link
 *  rewriting. Call once per process and reuse across renders. */
export function createWikiMarkdown(): Promise<MarkdownIt> {
  mdPromise ??= buildWikiMarkdown();
  return mdPromise;
}

async function buildWikiMarkdown(): Promise<MarkdownIt> {
  const highlighter = await getHighlighter();
  const loaded = new Set(highlighter.getLoadedLanguages());
  const md = new MarkdownItCtor({ html: false, linkify: true });

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]!;
    const lang = (token.info || "").trim().split(/\s+/)[0] ?? "";
    if (lang === "mermaid") {
      return `<pre class="mermaid">${escapeHtml(token.content)}</pre>\n`;
    }
    return highlighter.codeToHtml(token.content, {
      lang: loaded.has(lang) ? lang : "text",
      themes: SHIKI_THEMES,
      defaultColor: false,
    });
  };

  md.renderer.rules.code_inline = (tokens, idx, _options, env) => {
    const token = tokens[idx]!;
    const href = (env as RenderEnv | undefined)?.sourceLinks?.get(token.content);
    const code = `<code>${escapeHtml(token.content)}</code>`;
    return href === undefined ? code : `<a href="${escapeAttr(href)}">${code}</a>`;
  };

  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const level = Number(token.tag.slice(1));
    if (level >= 1 && level <= 3) {
      const text = (tokens[idx + 1]?.children ?? []).map((child) => child.content).join("");
      const slugEnv = env as SlugEnv;
      const counts = (slugEnv[SLUG_COUNTS] ??= new Map());
      const base = slugifyHeading(text);
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      const id = seen === 0 ? base : `${base}-${seen}`;
      token.attrSet("id", id);
      (env as RenderEnv).outline?.push({ level, text, id });
    }
    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const href = token.attrGet("href");
    const renderEnv = env as RenderEnv | undefined;
    if (typeof href === "string" && renderEnv?.conceptIds && !EXTERNAL_HREF_RE.test(href)) {
      const resolved = resolveLink(href, renderEnv.fromDir, renderEnv.conceptIds);
      if (resolved) {
        token.attrSet("href", `/wiki/${renderEnv.repoId}/${resolved}`);
      } else if (href.replace(/#.*$/, "").endsWith("/")) {
        // A trailing slash is the actual directory-reference convention
        // openwiki's index.md files use (e.g. `[architecture](architecture/)`)
        // — narrower than "not a concept link", which would also catch a
        // relative link to a non-page file and rewrite it into a dead
        // /wiki/... URL instead of leaving it as the (equally dead, but
        // recognizably original) link the author wrote.
        const dirPath = joinBundlePath(href, renderEnv.fromDir);
        token.attrSet(
          "href",
          dirPath ? `/wiki/${renderEnv.repoId}/${dirPath}` : `/wiki/${renderEnv.repoId}`,
        );
      }
    }
    return self.renderToken(tokens, idx, options);
  };

  return md;
}

/** True when a rendered fragment contains a diagram — gates loading the
 *  Mermaid client module, which otherwise ships on every page. */
export function hasMermaidDiagram(html: string): boolean {
  return html.includes('class="mermaid"');
}
