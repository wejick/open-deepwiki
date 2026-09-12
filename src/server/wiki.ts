import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import type { Client } from "@libsql/client";
import matter from "gray-matter";
import type { Config } from "../config/config.ts";
import { getChunk, listChunks } from "../index/db.ts";
import { NO_MATTER_CACHE, bundleDir } from "../producer/verify.ts";
import { citedPath, lineRangeOf } from "../producer/grounding.ts";
import type { Registry, RepoRecord } from "../repoManager/registry.ts";
import { webSourceUrl } from "../repoManager/webLinks.ts";
import {
  createWikiMarkdown,
  escapeAttr,
  escapeHtml,
  hasMermaidDiagram,
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

export function renderShell(opts: {
  title: string;
  breadcrumb: Crumb[];
  contentHtml: string;
  includeMermaid: boolean;
}): string {
  const crumbHtml = opts.breadcrumb
    .map((c) =>
      c.href
        ? `<a href="${escapeAttr(c.href)}">${escapeHtml(c.label)}</a>`
        : `<span aria-current="page">${escapeHtml(c.label)}</span>`,
    )
    .join(' <span class="sep">/</span> ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
<style>${WIKI_CSS}</style>
</head>
<body>
<header class="topbar"><nav class="breadcrumb">${crumbHtml}</nav></header>
<main class="content">${opts.contentHtml}</main>
${opts.includeMermaid ? MERMAID_BOOTSTRAP : ""}
</body>
</html>`;
}

const WIKI_CSS = `
:root {
  --bg: #ffffff; --fg: #1c1e21; --muted: #6b7280; --border: #e5e7eb;
  --link: #0b5fff; --code-bg: #f6f8fa; --shiki-light-bg: #f6f8fa; --shiki-dark-bg: #0d1117;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --border: #30363d;
    --link: #6ea8fe; --code-bg: #161b22;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, Roboto, sans-serif;
  font-size: 16px; line-height: 1.5;
}
.topbar {
  position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--border);
  padding: 0.75rem 1.25rem; font-size: 0.9rem;
}
.breadcrumb a { color: var(--muted); text-decoration: none; }
.breadcrumb a:hover { color: var(--link); text-decoration: underline; }
.breadcrumb .sep { color: var(--border); padding: 0 0.15rem; }
.breadcrumb [aria-current] { color: var(--fg); font-weight: 600; }
.content {
  max-width: 42rem; margin: 0 auto; padding: 2.5rem 1.5rem 5rem;
}
.content h1, .content h2, .content h3 { line-height: 1.3; letter-spacing: -0.01em; }
.content a { color: var(--link); }
.content pre { overflow-x: auto; border-radius: 6px; padding: 1rem; }
.content pre.shiki, .content pre.shiki span { color: var(--shiki-light); }
.content pre.shiki { background-color: var(--shiki-light-bg) !important; }
@media (prefers-color-scheme: dark) {
  .content pre.shiki, .content pre.shiki span {
    color: var(--shiki-dark) !important; background-color: var(--shiki-dark-bg) !important;
  }
}
.content :not(pre) > code {
  background: var(--code-bg); border-radius: 4px; padding: 0.1em 0.35em;
  font-size: 0.9em;
}
.content pre.mermaid { background: none; text-align: center; }
.content table { border-collapse: collapse; width: 100%; }
.content th, .content td { border: 1px solid var(--border); padding: 0.4rem 0.6rem; text-align: left; }
.repo-list { list-style: none; padding: 0; }
.repo-list li { padding: 0.35rem 0; border-bottom: 1px solid var(--border); }
.content .sources { margin-top: 2.5rem; border-top: 1px solid var(--border); }
.content .sources h2 { font-size: 1rem; color: var(--muted); }
.content .sources ul { padding-left: 1.25rem; }
`;

const MERMAID_BOOTSTRAP = `<script type="module">
  import mermaid from "${MERMAID_ENTRY_PATH}";
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  mermaid.run({ querySelector: ".mermaid" });
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

type RenderedPage = { html: string; title: string };

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
  };
  const html = md.render(body, env);
  const title = rest === "" ? repo.repoId : (rest.split("/").at(-1) ?? repo.repoId);
  return { html, title };
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
  };
  const html = md.render(parsed.content, env) + renderSources(parsed.data, repo);
  const title =
    typeof parsed.data.title === "string" ? parsed.data.title : (path.split("/").at(-1) ?? path);
  return { html, title };
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

  // Bootstrap: `?token=` on any /wiki path sets the session cookie and
  // redirects to the same path without the query, so deep links
  // (`/wiki/<repoId>?token=…`, e.g. from the dashboard) work in one hop.
  const tokenParam = parsed.searchParams.get("token");
  if (tokenParam !== null) {
    // No session is needed at all on a localhost bind (or when no token is
    // configured) — validating here would 401 a stale/copy-pasted `?token=`
    // even though the bare URL would have worked unauthenticated.
    if (deps.requiresToken) {
      if (!deps.cfg.bearerToken || tokenParam !== deps.cfg.bearerToken) {
        sendText(res, 401, "invalid token");
        return true;
      }
      res.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${encodeURIComponent(tokenParam)}; Path=/wiki; HttpOnly; SameSite=Lax`,
      );
    }
    res.writeHead(302, { location: pathname });
    res.end();
    return true;
  }

  if (deps.requiresToken && !hasValidSession(req, deps.cfg)) {
    sendText(res, 401, "unauthorized — visit /wiki?token=<token> once to start a session");
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

  const page =
    resolved.rest !== ""
      ? ((await renderConceptPage(deps.db, repo, resolved.rest)) ??
        (await renderIndexPage(deps.db, repo, resolved.rest)))
      : await renderIndexPage(deps.db, repo, "");
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
    }),
  );
  return true;
}
