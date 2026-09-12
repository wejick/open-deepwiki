import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import type { Client } from "@libsql/client";
import matter from "gray-matter";
import type { Config } from "../config/config.ts";
import { getChunk, listChunks } from "../index/db.ts";
import { joinBundlePath, resolveLink } from "../index/ingest.ts";
import { NO_MATTER_CACHE, bundleDir, walkMd } from "../producer/verify.ts";
import { citedPath, lineRangeOf } from "../producer/grounding.ts";
import type { Registry, RepoRecord } from "../repoManager/registry.ts";
import { webCommitUrl, webSourceUrl } from "../repoManager/webLinks.ts";
import {
  createWikiMarkdown,
  escapeAttr,
  escapeHtml,
  hasMermaidDiagram,
  parseInlineCitation,
  type OutlineEntry,
  type RenderEnv,
} from "./wikiRender.ts";

/**
 * Browsable, server-rendered `/wiki` HTTP surface (spec: wiki-viewer). Reads
 * the same chunks/bundles the MCP tools already read; renders full HTML
 * pages, no client router. Auth is self-contained (a cookie carrying the
 * shared bearer token) and does not touch `/api/*`/`/mcp`'s header check.
 */

export type WikiDeps = {
  cfg: Config;
  db: Client;
  getRegistry: () => Promise<Registry>;
  requiresToken: boolean;
  /** Absolute path to the installed `mermaid` package's `dist/` directory.
   *  Its ESM entry dynamically imports per-diagram-type chunks from beside
   *  itself at runtime, so the whole directory is served, not one file. */
  mermaidDistDir: string;
};

const COOKIE_NAME = "odw_wiki_token";
const THEME_COOKIE = "odw_wiki_theme";
const THEMES = ["light", "dark", "system"] as const;
export type WikiTheme = (typeof THEMES)[number];
const THEME_MAX_AGE = 31536000; // one year
const MERMAID_ASSET_PREFIX = "/wiki/assets/mermaid/";
const MERMAID_ENTRY_PATH = `${MERMAID_ASSET_PREFIX}mermaid.esm.min.mjs`;

// ---- pure helpers ----

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function hasValidSession(req: IncomingMessage, cfg: Config): boolean {
  if (!cfg.bearerToken) return false;
  return parseCookies(req.headers.cookie)[COOKIE_NAME] === cfg.bearerToken;
}

/** Cookie or query value to a recognized theme; anything else is `system`
 *  (spec: wiki-viewer › Wiki theme preference). */
export function parseTheme(value: string | null | undefined): WikiTheme {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function themeFromRequest(req: IncomingMessage): WikiTheme {
  return parseTheme(parseCookies(req.headers.cookie)[THEME_COOKIE]);
}

function themeCookie(theme: WikiTheme): string {
  return `${THEME_COOKIE}=${theme}; Path=/wiki; HttpOnly; SameSite=Lax; Max-Age=${THEME_MAX_AGE}`;
}

/** Longest-registry-prefix split of a `/wiki/...` pathname into repoId + page
 *  path (spec: wiki-viewer › Wiki page routing). repoIds and concept paths
 *  both contain slashes, but a registered repoId can never be a literal
 *  prefix of another — `repoIdFromSource` suffixes collisions rather than
 *  nesting them — so the longest match is unambiguous. */
export function resolveWikiPath(
  pathname: string,
  repos: Pick<RepoRecord, "repoId">[],
): { repoId: string; rest: string } | null {
  const afterWiki = decodeURIComponent(pathname.replace(/^\/wiki\/?/, ""));
  if (afterWiki === "") return null;
  let best: string | null = null;
  for (const r of repos) {
    if (afterWiki === r.repoId || afterWiki.startsWith(`${r.repoId}/`)) {
      if (best === null || r.repoId.length > best.length) best = r.repoId;
    }
  }
  if (best === null) return null;
  return { repoId: best, rest: afterWiki.slice(best.length).replace(/^\/+/, "") };
}

export type Crumb = { label: string; href: string | null };

/** repoId plus each path segment; every segment before the current page
 *  links to its own listing or page (spec: wiki-viewer › Breadcrumb
 *  navigation). */
export function buildBreadcrumb(repoId: string, rest: string, currentTitle: string): Crumb[] {
  const segments = rest.split("/").filter(Boolean);
  if (segments.length === 0) return [{ label: repoId, href: null }];
  const crumbs: Crumb[] = [{ label: repoId, href: `/wiki/${repoId}` }];
  let path = repoId;
  for (let i = 0; i < segments.length - 1; i++) {
    path = `${path}/${segments[i]}`;
    crumbs.push({ label: segments[i]!, href: `/wiki/${path}` });
  }
  crumbs.push({ label: currentTitle, href: null });
  return crumbs;
}

export function renderRepoListBody(repos: Pick<RepoRecord, "repoId">[]): string {
  if (repos.length === 0) return "<p>No repositories registered yet.</p>";
  const items = repos
    .map((r) => `<li><a href="/wiki/${escapeAttr(r.repoId)}">${escapeHtml(r.repoId)}</a></li>`)
    .join("");
  return `<ul class="repo-list">${items}</ul>`;
}

export type NavConcept = { path: string; title: string };
export type NavEntry = { label: string; target: string };
export type NavNode =
  | { kind: "page"; path: string; label: string }
  | { kind: "dir"; path: string; label: string; children: NavNode[] };

export type SidebarRepo = Pick<
  RepoRecord,
  "repoId" | "source" | "lastIndexedSha" | "lastSuccessAt"
>;

/** An `index.md` body's Markdown links in document order, which is the only
 *  in-bundle navigation signal (spec: wiki-viewer › Wiki navigation sidebar). */
export function parseIndexOrder(body: string): NavEntry[] {
  const out: NavEntry[] = [];
  for (const m of body.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    out.push({ label: m[1] ?? "", target: m[2] ?? "" });
  }
  return out;
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function baseName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** Derived labels (directory names, title-less concepts) present Title Case so
 *  they sit beside the authored titles around them (spec: wiki-viewer › Wiki
 *  navigation sidebar). Authored titles are never rewritten. */
function titleCase(label: string): string {
  return label
    .replace(/[-_]+/g, " ")
    .replace(/(^|\s)([a-z])/g, (_m, before: string, ch: string) => before + ch.toUpperCase());
}

/** Nests indexed concepts by directory and orders each directory's entries as
 *  its `index.md` listed them, with anything unlisted appended in path order
 *  (spec: wiki-viewer › Wiki navigation sidebar). A directory node exists when
 *  a concept lives under it or the bundle ships an `index.md` for it. */
export function buildNavTree(
  concepts: NavConcept[],
  orders: ReadonlyMap<string, NavEntry[]>,
): NavNode[] {
  const conceptIds = new Set(concepts.map((c) => c.path));
  const titles = new Map(concepts.map((c) => [c.path, c.title]));
  const dirs = new Set<string>([""]);
  const addDir = (path: string): void => {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  };
  for (const c of concepts) {
    const dir = parentDir(c.path);
    if (dir !== "") addDir(dir);
  }
  for (const key of orders.keys()) {
    if (key !== "") addDir(key);
  }

  const childDirs = (dir: string): string[] =>
    [...dirs].filter((d) => d !== "" && parentDir(d) === dir);

  const build = (dir: string): NavNode[] => {
    const nodes: NavNode[] = [];
    const listedPages = new Set<string>();
    const listedDirs = new Set<string>();
    for (const entry of orders.get(dir) ?? []) {
      const page = resolveLink(entry.target, dir, conceptIds);
      if (page !== null && parentDir(page) === dir) {
        if (listedPages.has(page)) continue;
        listedPages.add(page);
        nodes.push({
          kind: "page",
          path: page,
          label: titles.get(page) ?? titleCase(baseName(page)),
        });
        continue;
      }
      if (!(entry.target.split("#")[0] ?? "").endsWith("/")) continue;
      const child = joinBundlePath(entry.target, dir);
      if (child === "" || parentDir(child) !== dir || !dirs.has(child)) continue;
      if (listedDirs.has(child)) continue;
      listedDirs.add(child);
      nodes.push({
        kind: "dir",
        path: child,
        label: titleCase(entry.label || baseName(child)),
        children: build(child),
      });
    }

    const rest: NavNode[] = [];
    for (const child of childDirs(dir)) {
      if (!listedDirs.has(child)) {
        rest.push({
          kind: "dir",
          path: child,
          label: titleCase(baseName(child)),
          children: build(child),
        });
      }
    }
    for (const concept of concepts) {
      if (parentDir(concept.path) === dir && !listedPages.has(concept.path)) {
        rest.push({
          kind: "page",
          path: concept.path,
          label: concept.title || titleCase(baseName(concept.path)),
        });
      }
    }
    rest.sort((a, b) => (a.path < b.path ? -1 : 1));
    return [...nodes, ...rest];
  };

  return build("");
}

function renderIndexedLine(repo: SidebarRepo): string {
  const sha = repo.lastIndexedSha;
  if (sha === null || sha === "") return "";
  const short = sha.slice(0, 7);
  const href = webCommitUrl(repo.source, sha);
  const revision =
    href === null ? escapeHtml(short) : `<a href="${escapeAttr(href)}">${escapeHtml(short)}</a>`;
  const date = repo.lastSuccessAt?.slice(0, 10);
  return `<p class="indexed">Last indexed: ${date ? `${escapeHtml(date)} ` : ""}(${revision})</p>`;
}

function renderNavNodes(nodes: NavNode[], repoId: string, current: string): string {
  return nodes
    .map((node) => {
      const currentAttr = node.path === current ? ' aria-current="page"' : "";
      const link = `<a${currentAttr} href="${escapeAttr(`/wiki/${repoId}/${node.path}`)}">${escapeHtml(node.label)}</a>`;
      return node.kind === "page"
        ? `<li>${link}</li>`
        : `<li class="dir">${link}<ul>${renderNavNodes(node.children, repoId, current)}</ul></li>`;
    })
    .join("");
}

/** The repository's page tree, with the current page or directory marked
 *  (spec: wiki-viewer › Wiki navigation sidebar). */
export function renderSidebar(tree: NavNode[], currentPath: string, repo: SidebarRepo): string {
  return `<nav class="sidebar" aria-label="Wiki pages">${renderIndexedLine(repo)}<ul>${renderNavNodes(
    tree,
    repo.repoId,
    currentPath,
  )}</ul></nav>`;
}

/** Frontmatter `sources` as a linked footer: `repo://` citations link to the
 *  forge at the indexed revision when one is derivable and render as plain
 *  `path:range` text otherwise; non-repo resources are omitted (spec:
 *  wiki-viewer › Page sources rendered with forge links). */
export function renderSources(
  frontmatter: Record<string, unknown>,
  repo: Pick<RepoRecord, "source" | "lastIndexedSha">,
): string {
  const sources = frontmatter.sources;
  if (!Array.isArray(sources)) return "";
  const items: string[] = [];
  for (const entry of sources) {
    if (entry === null || typeof entry !== "object") continue;
    const resource = (entry as { resource?: unknown }).resource;
    const path = citedPath(resource);
    if (path === null) continue;
    const range = lineRangeOf(resource);
    const label =
      range === null
        ? path
        : range.start === range.end
          ? `${path}:${range.start}`
          : `${path}:${range.start}-${range.end}`;
    const href = webSourceUrl(repo.source, repo.lastIndexedSha, path, range);
    items.push(
      href === null
        ? `<li><code>${escapeHtml(label)}</code></li>`
        : `<li><a href="${escapeAttr(href)}"><code>${escapeHtml(label)}</code></a></li>`,
    );
  }
  if (items.length === 0) return "";
  return `<section class="sources"><h2>Sources</h2><ul>${items.join("")}</ul></section>`;
}

/** Inline `path:start-end` code spans resolved to forge permalinks, keyed by
 *  the span's exact text. A mention links only when its path is a real file in
 *  the checkout, so references to other repos or dependencies stay plain
 *  (spec: wiki-viewer › Inline source citations linked). */
export function inlineSourceLinks(
  body: string,
  repo: Pick<RepoRecord, "clonePath" | "source" | "lastIndexedSha">,
): Map<string, string> {
  const links = new Map<string, string>();
  const root = resolvePath(repo.clonePath);
  for (const match of body.matchAll(/`([^`\n]+)`/g)) {
    const raw = match[1];
    if (raw === undefined || raw === "" || links.has(raw)) continue;
    const citation = parseInlineCitation(raw);
    if (citation === null) continue;
    const abs = resolvePath(root, citation.path);
    if (!abs.startsWith(root + sep)) continue;
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    const href = webSourceUrl(repo.source, repo.lastIndexedSha, citation.path, citation.range);
    if (href !== null) links.set(raw, href);
  }
  return links;
}

export function renderShell(opts: {
  title: string;
  breadcrumb: Crumb[];
  contentHtml: string;
  includeMermaid: boolean;
  sidebarHtml?: string;
  outline?: OutlineEntry[];
  theme?: WikiTheme;
}): string {
  const theme = opts.theme ?? "system";
  const crumbHtml = opts.breadcrumb
    .map((c) =>
      c.href
        ? `<a href="${escapeAttr(c.href)}">${escapeHtml(c.label)}</a>`
        : `<span aria-current="page">${escapeHtml(c.label)}</span>`,
    )
    .join(' <span class="sep">/</span> ');
  const outlineHtml = renderOutline(opts.outline ?? []);
  const layoutClass = opts.sidebarHtml === undefined ? "layout layout--plain" : "layout";
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
<style>${WIKI_CSS}</style>
</head>
<body>
<header class="topbar"><nav class="breadcrumb">${crumbHtml}</nav>${renderThemeSwitch(theme)}</header>
<div class="${layoutClass}">
${opts.sidebarHtml ?? ""}
<main class="content">${opts.contentHtml}</main>
${outlineHtml}
</div>
${opts.includeMermaid ? MERMAID_BOOTSTRAP : ""}
${outlineHtml === "" ? "" : OUTLINE_SPY}
</body>
</html>`;
}

/** Zero-JS toggle: each link sets the theme cookie via `?theme=` and the
 *  server redirects back (spec: wiki-viewer › Wiki theme preference). */
function renderThemeSwitch(theme: WikiTheme): string {
  const labels: Record<WikiTheme, string> = { light: "Light", dark: "Dark", system: "Auto" };
  const links = THEMES.map((value) => {
    const current = value === theme ? ' aria-current="true"' : "";
    return `<a${current} href="?theme=${value}">${labels[value]}</a>`;
  }).join("");
  return `<nav class="theme-switch" aria-label="Theme">${links}</nav>`;
}

/** "On this page" rail, indented 12px per level below the shallowest heading
 *  (spec: wiki-viewer › On this page outline). */
function renderOutline(entries: OutlineEntry[]): string {
  if (entries.length === 0) return "";
  const base = Math.min(...entries.map((e) => e.level));
  const items = entries
    .map((e) => {
      return `<li style="padding-left:${(e.level - base) * 12}px"><a href="#${escapeAttr(e.id)}">${escapeHtml(e.text)}</a></li>`;
    })
    .join("");
  return `<aside class="outline" aria-label="On this page"><h2>On this page</h2><ul>${items}</ul></aside>`;
}

const WIKI_CSS = `
:root {
  --font-sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

  --bg: #f8f7f6; --hover: #e8e8e8; --border: #e0e0e0;
  --fg: #333333; --muted: #666666; --link: var(--fg);
  --code-bg: #f1f1f1; --inline-code-bg: rgba(0, 0, 0, 0.05);
  --selection: color-mix(in oklab, var(--link) 22%, transparent);
  color-scheme: light;

  --topbar-h: 3.25rem; --rail-w: 16rem; --toc-w: 16rem;
}
[data-theme="dark"] {
  --bg: #303841; --hover: #414850; --border: #495058;
  --fg: #d8dee9; --muted: #a6acb9;
  --code-bg: #363e47; --inline-code-bg: #3e4852; --selection: #4d5864;
  color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
  [data-theme="system"] {
    --bg: #303841; --hover: #414850; --border: #495058;
    --fg: #d8dee9; --muted: #a6acb9;
    --code-bg: #363e47; --inline-code-bg: #3e4852; --selection: #4d5864;
    color-scheme: dark;
  }
}
::selection { background: var(--selection); }
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font-family: var(--font-sans); font-size: 16px; line-height: 1.75;
}
.topbar {
  position: sticky; top: 0; z-index: 1; height: var(--topbar-h);
  display: flex; align-items: center;
  background: var(--bg); border-bottom: 1px solid var(--border);
  padding: 0 1.5rem; font-size: 0.875rem;
}
.breadcrumb { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.breadcrumb a { color: var(--muted); text-decoration: none; }
.breadcrumb a:hover { color: var(--link); text-decoration: underline; }
.breadcrumb .sep { color: var(--border); padding: 0 0.15rem; }
.breadcrumb [aria-current] { color: var(--fg); font-weight: 600; }
.theme-switch { margin-left: auto; padding-left: 1rem; flex-shrink: 0; display: flex; gap: 0.25rem; }
.theme-switch a {
  color: var(--muted); text-decoration: none; padding: 0.15rem 0.5rem; border-radius: 999px;
}
.theme-switch a:hover { color: var(--fg); background: var(--hover); }
.theme-switch a[aria-current="true"] { color: var(--fg); background: var(--hover); font-weight: 600; }
.layout {
  display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr) var(--toc-w);
  gap: 2rem; align-items: start; max-width: 96rem; margin: 0 auto; padding: 0 1.5rem;
}
.layout--plain { display: block; }
.sidebar, .outline {
  position: sticky; top: var(--topbar-h); padding: 2rem 0 5rem;
  max-height: calc(100vh - var(--topbar-h)); overflow-y: auto;
}
.sidebar { border-right: 1px dashed var(--border); padding-right: 1rem; font-size: 0.875rem; }
.sidebar ul { list-style: none; margin: 0; padding: 0; }
.sidebar ul ul { margin-left: 0.75rem; }
.sidebar li { margin: 0.1rem 0; }
.sidebar a {
  display: block; padding: 0.3rem 0.5rem; border-radius: 4px;
  color: var(--muted); text-decoration: none;
}
.sidebar a:hover { background: var(--hover); color: var(--fg); }
.sidebar a[aria-current="page"] { background: var(--hover); color: var(--fg); font-weight: 600; }
.sidebar .indexed {
  margin: 0 0 0.75rem; padding: 0 0.5rem; color: var(--muted); font-size: 0.75rem;
}
.sidebar .indexed a { display: inline; padding: 0; text-decoration: underline; }
.outline { font-size: 0.875rem; }
.outline h2 {
  margin: 0 0 1.25rem; padding: 0 1rem; font-size: 1.125rem; font-weight: 500;
  line-height: 1; color: var(--fg);
}
.outline ul { list-style: none; margin: 0; padding: 0 1rem; }
.outline li + li { margin-top: 0.75rem; }
.outline a { color: var(--muted); text-decoration: none; }
.outline a:hover { color: var(--fg); }
.outline a[aria-current] { color: var(--fg); font-weight: 500; }
.content { max-width: 42rem; width: 100%; margin: 0 auto; padding: 2.5rem 0 5rem; }
.layout--plain .content { padding: 2.5rem 1.5rem 5rem; }
.content h1, .content h2, .content h3 { scroll-margin-top: calc(var(--topbar-h) + 0.5rem); }
.content h1 { font-size: 1.375rem; font-weight: 700; line-height: 1.875rem; margin: 0 0 0.8em; }
.content h2 { font-size: 1.25rem; font-weight: 700; line-height: 1.75rem; margin: 1.5em 0 0.8em; }
.content h3 { font-size: 1.2em; font-weight: 600; line-height: 1.65; margin: 1.5em 0 0.5em; }
.content p { margin: 1.15em 0; }
.content li { margin: 0.35em 0; }
.content a { color: var(--link); font-weight: 500; text-decoration: underline; text-underline-offset: 2px; }
.content blockquote { margin: 1.5em 0; padding: 0 1em; border-left: 3px solid var(--border); color: var(--muted); }
.content hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
.content img { max-width: 100%; }
.content pre {
  overflow-x: auto; font-family: var(--font-mono); font-size: 0.85em;
  line-height: 1.75; border-radius: 6px; padding: 0.857em 1.143em;
}
.content pre.shiki, .content pre.shiki span { color: var(--shiki-light); }
.content pre.shiki { background-color: var(--code-bg) !important; }
[data-theme="dark"] .content pre.shiki,
[data-theme="dark"] .content pre.shiki span { color: var(--shiki-dark); }
@media (prefers-color-scheme: dark) {
  [data-theme="system"] .content pre.shiki,
  [data-theme="system"] .content pre.shiki span { color: var(--shiki-dark); }
}
.content :not(pre) > code {
  background: var(--inline-code-bg); border-radius: 4px; padding: 0.15em 0.35em;
  font-family: var(--font-mono); font-size: 0.85em; font-weight: 600;
}
.content pre.mermaid {
  position: relative; background: none; text-align: center; padding: 1rem;
  cursor: pointer; border: 1px solid var(--border); border-radius: 6px;
  transition: border-color 0.15s;
}
.content pre.mermaid:hover, .content pre.mermaid:focus-visible { border-color: var(--muted); }
.diagram-tools {
  position: absolute; top: 0.5rem; right: 0.5rem; display: flex; gap: 0.25rem;
  opacity: 0; transition: opacity 0.15s;
}
.content pre.mermaid:hover .diagram-tools,
.content pre.mermaid:focus-within .diagram-tools,
.diagram-modal .diagram-tools { opacity: 1; }
.diagram-tools button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.75rem; height: 1.75rem; border: 1px solid var(--border); border-radius: 4px;
  background: var(--bg); color: var(--muted); font-size: 1rem; line-height: 1;
  cursor: pointer; opacity: 0.7; transition: opacity 0.15s, color 0.15s;
}
.diagram-tools button:hover, .diagram-tools button:focus-visible { opacity: 1; color: var(--fg); }
.diagram-modal {
  width: 90vw; max-width: 90vw; height: 90vh; max-height: 90vh; margin: auto;
  border: 1px solid var(--border); border-radius: 8px; padding: 0;
  background: var(--bg); overflow: hidden;
}
.diagram-modal::backdrop { background: rgb(0 0 0 / 0.45); }
.diagram-modal-stage { position: relative; width: 100%; height: 100%; }
.diagram-modal-stage svg { width: 100%; height: 100%; max-width: none; }
.content table { border-collapse: collapse; width: 100%; font-size: 0.875em; line-height: 1.5; }
.content th, .content td { border: 1px solid var(--border); padding: 0.4rem 0.6rem; text-align: left; }
.repo-list { list-style: none; padding: 0; }
.repo-list li { padding: 0.35rem 0; border-bottom: 1px solid var(--border); }
.content .sources { margin-top: 2.5rem; border-top: 1px solid var(--border); }
.content .sources h2 { font-size: 1rem; color: var(--muted); }
.content .sources ul { padding-left: 1.25rem; }
@media (max-width: 1200px) {
  .layout { grid-template-columns: var(--rail-w) minmax(0, 1fr); }
  .outline { display: none; }
}
@media (max-width: 900px) {
  .layout { grid-template-columns: minmax(0, 1fr); padding: 0 1.25rem; }
  .sidebar { display: none; }
}
`;

const OUTLINE_SPY = `<script type="module">
  const links = new Map(
    [...document.querySelectorAll(".outline a")].map((a) => [a.hash.slice(1), a]),
  );
  const headings = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  const update = () => {
    const line = document.querySelector(".topbar").getBoundingClientRect().bottom + 8;
    let active = headings[0];
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= line) active = heading;
    }
    for (const link of links.values()) link.removeAttribute("aria-current");
    if (active) links.get(active.id)?.setAttribute("aria-current", "location");
  };
  addEventListener("scroll", () => requestAnimationFrame(update), { passive: true });
  update();
</script>`;

const MERMAID_BOOTSTRAP = `<script type="module">
  import mermaid from "${MERMAID_ENTRY_PATH}";
  const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = document.documentElement.dataset.theme;
  const dark = theme === "dark" || (theme !== "light" && prefersDark);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: dark
      ? { background: "transparent", primaryColor: "#414850", primaryTextColor: "#d8dee9", primaryBorderColor: "#495058", lineColor: "#a6acb9", secondaryColor: "#384049", tertiaryColor: "#303841" }
      : { background: "transparent", primaryColor: "#e8e8e8", primaryTextColor: "#333333", primaryBorderColor: "#e0e0e0", lineColor: "#666666", secondaryColor: "#f2f1f0", tertiaryColor: "#f8f7f6" },
  });
  await mermaid.run({ querySelector: ".mermaid" });
  const MIN_ZOOM = 0.2, MAX_ZOOM = 5, ZOOM_STEP = 1.2, WHEEL_STEP = 1.06;
  const setupViewer = (svg) => {
    if (!svg || !svg.viewBox.baseVal.width || !svg.viewBox.baseVal.height) return null;
    const naturalWidth = svg.viewBox.baseVal.width;
    svg.style.touchAction = "none";
    svg.style.userSelect = "none";
    svg.style.cursor = "grab";
    const apply = (x, y, w, h) => svg.setAttribute("viewBox", x + " " + y + " " + w + " " + h);
    const zoom = (scale, px, py) => {
      const box = svg.viewBox.baseVal;
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const w = Math.max(naturalWidth / MAX_ZOOM, Math.min(naturalWidth / MIN_ZOOM, box.width * scale));
      const h = w * (box.height / box.width);
      const cx = px ?? rect.width / 2;
      const cy = py ?? rect.height / 2;
      apply(box.x + (box.width - w) * (cx / rect.width), box.y + (box.height - h) * (cy / rect.height), w, h);
    };
    let drag = null;
    svg.addEventListener("pointerdown", (event) => {
      drag = { x: event.clientX, y: event.clientY, bx: svg.viewBox.baseVal.x, by: svg.viewBox.baseVal.y };
      svg.setPointerCapture(event.pointerId);
      svg.style.cursor = "grabbing";
    });
    svg.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const rect = svg.getBoundingClientRect();
      const box = svg.viewBox.baseVal;
      apply(
        drag.bx - ((event.clientX - drag.x) * box.width) / rect.width,
        drag.by - ((event.clientY - drag.y) * box.height) / rect.height,
        box.width,
        box.height,
      );
    });
    const endDrag = () => {
      drag = null;
      svg.style.cursor = "grab";
    };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);
    svg.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        const factor = Math.pow(WHEEL_STEP, event.deltaY > 0 ? 1 : -1);
        zoom(factor, event.clientX - rect.left, event.clientY - rect.top);
      },
      { passive: false },
    );
    return { zoom };
  };
  const toolButton = (act, label, inner) =>
    '<button type="button" data-act="' + act + '" aria-label="' + label + '">' + inner + "</button>";
  const ZOOM_IN = toolButton("in", "Zoom in", "+");
  const ZOOM_OUT = toolButton("out", "Zoom out", "−");
  const EXPAND_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5"/></svg>';
  const wireTools = (tools, viewer, onClose) => {
    tools.querySelector('[data-act="in"]').addEventListener("click", () => viewer.zoom(1 / ZOOM_STEP));
    tools.querySelector('[data-act="out"]').addEventListener("click", () => viewer.zoom(ZOOM_STEP));
    if (onClose) tools.querySelector('[data-act="close"]').addEventListener("click", onClose);
  };
  const expand = (source) => {
    const dialog = document.createElement("dialog");
    dialog.className = "diagram-modal";
    const stage = document.createElement("div");
    stage.className = "diagram-modal-stage";
    const clone = source.cloneNode(true);
    clone.removeAttribute("width");
    clone.removeAttribute("height");
    clone.style.width = "100%";
    clone.style.height = "100%";
    clone.style.maxWidth = "none";
    stage.append(clone);
    const tools = document.createElement("div");
    tools.className = "diagram-tools";
    tools.innerHTML = ZOOM_IN + ZOOM_OUT + toolButton("close", "Close", "×");
    stage.append(tools);
    dialog.append(stage);
    document.body.append(dialog);
    const close = () => dialog.close();
    dialog.addEventListener("close", () => {
      document.body.style.overflow = "";
      dialog.remove();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) close();
    });
    document.body.style.overflow = "hidden";
    dialog.showModal();
    const viewer = setupViewer(clone);
    if (viewer) wireTools(tools, viewer, close);
    tools.querySelector('[data-act="close"]').focus();
  };
  for (const host of document.querySelectorAll("pre.mermaid")) {
    if (!host.querySelector("svg")) continue;
    host.setAttribute("role", "button");
    host.setAttribute("tabindex", "0");
    host.setAttribute("aria-label", "Expand diagram");
    const open = () => expand(host.querySelector("svg"));
    host.addEventListener("click", open);
    host.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    const tools = document.createElement("div");
    tools.className = "diagram-tools";
    tools.innerHTML = toolButton("expand", "Expand diagram", EXPAND_ICON);
    tools.querySelector('[data-act="expand"]').addEventListener("click", (event) => {
      event.stopPropagation();
      open();
    });
    host.append(tools);
  }
</script>`;

// ---- rendering (I/O) ----

/** Serves one file from the vendored Mermaid package under `/wiki/assets/
 *  mermaid/`. Reads per request rather than preloading — the package ships
 *  200+ per-diagram-type chunk files, and a page only ever needs a few. */
async function serveMermaidAsset(
  res: ServerResponse,
  distDir: string,
  subpath: string,
): Promise<boolean> {
  const root = resolvePath(distDir);
  const resolved = resolvePath(root, subpath);
  if (resolved !== root && !resolved.startsWith(root + sep)) return false; // path traversal guard
  try {
    const data = await readFile(resolved);
    res.writeHead(200, {
      "content-type": resolved.endsWith(".map")
        ? "application/json; charset=utf-8"
        : "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function readIndexMarkdown(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, "index.md"), "utf8");
  } catch {
    return null;
  }
}

async function conceptIdSet(db: Client, repoId: string): Promise<Set<string>> {
  const chunks = await listChunks(db, repoId, "wiki");
  return new Set(chunks.map((c) => c.path));
}

type RenderedPage = { html: string; title: string; outline: OutlineEntry[] };

/** Repo root (`rest === ""`) or a directory's `index.md` — read straight off
 *  disk since `index.md` files are excluded from indexing (spec: wiki-viewer
 *  › Wiki page routing, directory scenario). */
async function renderIndexPage(
  db: Client,
  repo: RepoRecord,
  rest: string,
): Promise<RenderedPage | null> {
  const dir = rest ? join(bundleDir(repo.clonePath), rest) : bundleDir(repo.clonePath);
  const raw = await readIndexMarkdown(dir);
  if (raw === null) return null;
  // The root index.md carries `okf_version` frontmatter; nested indexes have
  // none. gray-matter handles both — a frontmatter-less file round-trips its
  // content unchanged.
  const body = matter(raw, NO_MATTER_CACHE).content;
  const md = await createWikiMarkdown();
  const env: RenderEnv = {
    repoId: repo.repoId,
    fromDir: rest,
    conceptIds: await conceptIdSet(db, repo.repoId),
    outline: [],
  };
  const html = md.render(body, env);
  const title = rest === "" ? repo.repoId : (rest.split("/").at(-1) ?? repo.repoId);
  return { html, title, outline: env.outline ?? [] };
}

/** A leaf wiki concept page (spec: wiki-viewer › Rendered page content). */
async function renderConceptPage(
  db: Client,
  repo: RepoRecord,
  path: string,
): Promise<RenderedPage | null> {
  const chunk = await getChunk(db, repo.repoId, "wiki", path);
  if (!chunk) return null;
  let raw: string;
  try {
    // The index can outlive the file it points to (an update in progress, a
    // deleted page not yet re-indexed) — fall through to the directory/404
    // path below rather than a 500, matching readIndexMarkdown's leniency.
    raw = await readFile(chunk.filePath, "utf8");
  } catch {
    return null;
  }
  const parsed = matter(raw, NO_MATTER_CACHE);
  const md = await createWikiMarkdown();
  const fromDir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const env: RenderEnv = {
    repoId: repo.repoId,
    fromDir,
    conceptIds: await conceptIdSet(db, repo.repoId),
    sourceLinks: inlineSourceLinks(parsed.content, repo),
    outline: [],
  };
  const html = md.render(parsed.content, env) + renderSources(parsed.data, repo);
  const title =
    typeof parsed.data.title === "string" ? parsed.data.title : (path.split("/").at(-1) ?? path);
  return { html, title, outline: env.outline ?? [] };
}

/** Every directory's `index.md` order, read straight off disk — the authored
 *  order is the sidebar tree's only in-bundle signal (spec: wiki-viewer ›
 *  Wiki navigation sidebar). */
async function readIndexOrders(clonePath: string): Promise<Map<string, NavEntry[]>> {
  const root = bundleDir(clonePath);
  const dirs = new Set<string>([""]);
  for (const file of await walkMd(root)) {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const parts = dir.split("/");
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const orders = new Map<string, NavEntry[]>();
  for (const dir of dirs) {
    const raw = await readIndexMarkdown(dir === "" ? root : join(root, dir));
    if (raw !== null) orders.set(dir, parseIndexOrder(matter(raw, NO_MATTER_CACHE).content));
  }
  return orders;
}

async function buildSidebar(db: Client, repo: RepoRecord, currentPath: string): Promise<string> {
  const concepts = (await listChunks(db, repo.repoId, "wiki")).map((c) => ({
    path: c.path,
    title: c.title ?? c.path.split("/").at(-1) ?? c.path,
  }));
  const orders = await readIndexOrders(repo.clonePath);
  return renderSidebar(buildNavTree(concepts, orders), currentPath, repo);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

/** Returns false for non-`/wiki*` paths; owns all routing under `/wiki`. */
export async function handleWiki(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WikiDeps,
  url: string,
): Promise<boolean> {
  if (url !== "/wiki" && !url.startsWith("/wiki/") && !url.startsWith("/wiki?")) return false;

  const parsed = new URL(url, "http://internal");
  const pathname = parsed.pathname;
  const theme = themeFromRequest(req);
  const themeParam = parsed.searchParams.get("theme");
  const requestedTheme = THEMES.find((t) => t === themeParam) ?? null;

  // Bootstrap: `?token=` and/or `?theme=` on any /wiki path set their cookie
  // and redirect to the same path without the query, so deep links
  // (`/wiki/<repoId>?token=…`, e.g. from the dashboard) work in one hop.
  const tokenParam = parsed.searchParams.get("token");
  if (tokenParam !== null) {
    // No session is needed at all on a localhost bind (or when no token is
    // configured) — validating here would 401 a stale/copy-pasted `?token=`
    // even though the bare URL would have worked unauthenticated.
    const cookies: string[] = [];
    if (deps.requiresToken) {
      if (!deps.cfg.bearerToken || tokenParam !== deps.cfg.bearerToken) {
        sendText(res, 401, "invalid token");
        return true;
      }
      cookies.push(
        `${COOKIE_NAME}=${encodeURIComponent(tokenParam)}; Path=/wiki; HttpOnly; SameSite=Lax`,
      );
    }
    if (requestedTheme !== null) cookies.push(themeCookie(requestedTheme));
    if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);
    res.writeHead(302, { location: pathname });
    res.end();
    return true;
  }

  if (deps.requiresToken && !hasValidSession(req, deps.cfg)) {
    sendText(res, 401, "unauthorized — visit /wiki?token=<token> once to start a session");
    return true;
  }

  if (themeParam !== null) {
    if (requestedTheme !== null) res.setHeader("Set-Cookie", themeCookie(requestedTheme));
    res.writeHead(302, { location: pathname });
    res.end();
    return true;
  }

  if (pathname.startsWith(MERMAID_ASSET_PREFIX)) {
    const served = await serveMermaidAsset(
      res,
      deps.mermaidDistDir,
      pathname.slice(MERMAID_ASSET_PREFIX.length),
    );
    if (!served) sendText(res, 404, "not found");
    return true;
  }

  const registry = await deps.getRegistry();

  if (pathname === "/wiki") {
    sendHtml(
      res,
      200,
      renderShell({
        title: "open-deepwiki",
        breadcrumb: [{ label: "wiki", href: null }],
        contentHtml: `<h1>Repositories</h1>${renderRepoListBody(registry.repos)}`,
        includeMermaid: false,
        theme,
      }),
    );
    return true;
  }

  const resolved = resolveWikiPath(pathname, registry.repos);
  const repo = resolved ? registry.repos.find((r) => r.repoId === resolved.repoId) : undefined;
  if (!resolved || !repo) {
    sendText(res, 404, "not found");
    return true;
  }

  // The bare repo URL lands on the bundle's `overview` entry point when one
  // exists; a missing concept or a stale index falls back to the listing.
  let currentPath = resolved.rest;
  let page: RenderedPage | null;
  if (resolved.rest !== "") {
    page =
      (await renderConceptPage(deps.db, repo, resolved.rest)) ??
      (await renderIndexPage(deps.db, repo, resolved.rest));
  } else {
    page = await renderConceptPage(deps.db, repo, "overview");
    if (page === null) {
      page = await renderIndexPage(deps.db, repo, "");
    } else {
      currentPath = "overview";
    }
  }
  if (!page) {
    sendText(res, 404, "not found");
    return true;
  }

  sendHtml(
    res,
    200,
    renderShell({
      title: `${page.title} — ${resolved.repoId}`,
      breadcrumb: buildBreadcrumb(resolved.repoId, resolved.rest, page.title),
      contentHtml: page.html,
      includeMermaid: hasMermaidDiagram(page.html),
      sidebarHtml: await buildSidebar(deps.db, repo, currentPath),
      outline: page.outline,
      theme,
    }),
  );
  return true;
}
