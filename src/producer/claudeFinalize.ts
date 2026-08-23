import matter from "gray-matter";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NO_MATTER_CACHE, RESERVED_NAMES, walkMd } from "./verify.ts";

/**
 * Deterministic post-authoring pass for the `claude` producer only:
 * `finalizeClaudeBundle` regenerates every directory `index.md` from what is
 * actually on disk (`syncIndexes`) and degrades Mermaid fences that fail to
 * parse into plain text — the same guarantees openwiki's own internal
 * finalizer provides before its CLI exits, so neither producer's bundle has
 * these invariants rest on model behavior.
 *
 * Never run against an `openwiki`-produced bundle — its output is never
 * rewritten. `run.ts` calls this from inside `runClaude`, nowhere else; the
 * import site is enforced by `contract.test.ts`.
 */

type PageMeta = { file: string; title: string; description: string };

function escapeLabel(text: string): string {
  return text.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

async function pageMeta(dir: string, file: string): Promise<PageMeta> {
  const fallbackTitle = file.replace(/\.md$/, "");
  try {
    const raw = await readFile(join(dir, file), "utf8");
    const data = matter(raw, NO_MATTER_CACHE).data;
    const title =
      typeof data.title === "string" && data.title.trim() !== "" ? data.title : fallbackTitle;
    const description = typeof data.description === "string" ? data.description : "";
    return { file, title, description };
  } catch {
    return { file, title: fallbackTitle, description: "" };
  }
}

async function dirEntries(dir: string): Promise<{ files: string[]; dirs: string[] }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { files: [], dirs: [] };
  }
  const files: string[] = [];
  const dirs: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // .claims/, hidden files
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.name.endsWith(".md") && !RESERVED_NAMES.has(e.name)) files.push(e.name);
  }
  return { files: files.toSorted(), dirs: dirs.toSorted() };
}

function renderIndex(pages: PageMeta[], dirs: string[], isRoot: boolean): string {
  const sections: string[] = [];
  if (pages.length > 0) {
    const lines = pages.map(
      (p) => `- [${escapeLabel(p.title)}](${p.file})${p.description ? ` - ${p.description}` : ""}`,
    );
    sections.push(`# Files\n\n${lines.join("\n")}`);
  }
  if (dirs.length > 0) {
    const lines = dirs.map((d) => `- [${escapeLabel(d)}](${d}/)`);
    sections.push(`# Directories\n\n${lines.join("\n")}`);
  }
  const body = sections.join("\n\n");
  const frontmatter = isRoot ? '---\nokf_version: "0.2"\n---\n\n' : "";
  return body === "" ? frontmatter : `${frontmatter}${body}\n`;
}

/**
 * Regenerate every directory `index.md` in the bundle from the concept pages
 * and subdirectories actually on disk — replacing anything the model wrote
 * there, the same way openwiki's own `synchronizeWikiIndexes` does. The root
 * index always carries the `okf_version: "0.2"` marker; nested indexes carry
 * no frontmatter.
 */
export async function syncIndexes(bundleDir: string): Promise<void> {
  async function walk(dir: string): Promise<void> {
    const { files, dirs } = await dirEntries(dir);
    const pages = await Promise.all(files.map((f) => pageMeta(dir, f)));
    const isRoot = dir === bundleDir;
    if (pages.length > 0 || dirs.length > 0) {
      await writeFile(join(dir, "index.md"), renderIndex(pages, dirs, isRoot));
    } else {
      // Nothing left to list — a directory can reach this state on an update
      // that removed its last page. Regenerating "from what's actually on
      // disk" means a stale index pointing at deleted pages must go too, not
      // survive untouched because there was nothing new to write instead.
      await rm(join(dir, "index.md"), { force: true });
    }
    for (const d of dirs) await walk(join(dir, d));
  }
  await walk(bundleDir);
}

/* ── Mermaid validation ────────────────────────────────────────────────────
 * `jsdom`'s DOM globals must exist before `mermaid` is first imported — its
 * flowchart/state-diagram parsers call DOMPurify, which needs a DOM. A single
 * lazy, memoized loader owns that ordering; nothing else imports `mermaid`
 * for parsing.
 */

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
let jsdomWindow: Awaited<ReturnType<typeof loadJsdomWindow>> | null = null;

async function loadJsdomWindow() {
  const { JSDOM } = await import("jsdom");
  return new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
}

/**
 * Installs `window`/`document` on `globalThis` only for the duration of `fn`,
 * then restores whatever was there before — never left in place. This runs
 * inside a shared `bun test` process alongside code that assumes no DOM
 * exists (e.g. `dashboard.js`'s `typeof document !== "undefined"` guard);
 * leaving the shim on `globalThis` permanently broke that code in unrelated
 * test files.
 *
 * `globalThis` is process-wide, but repos are indexed with real concurrency
 * (`ODW_MAX_PARALLEL_INDEXING`), so two overlapping `claude` producer runs can
 * each reach this at once. A mutex serializes every call — including across
 * different repos' runs — so one call's install/restore can never interleave
 * with another's.
 */
let mutex: Promise<void> = Promise.resolve();
const NOOP = (): void => {};

async function withDomGlobals<T>(fn: () => Promise<T>): Promise<T> {
  const previous = mutex;
  let release = NOOP;
  mutex = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    jsdomWindow ??= await loadJsdomWindow();
    const g = globalThis as unknown as Record<string, unknown>;
    const hadWindow = Object.hasOwn(g, "window");
    const hadDocument = Object.hasOwn(g, "document");
    const prevWindow = g.window;
    const prevDocument = g.document;
    g.window = jsdomWindow;
    g.document = jsdomWindow.document;
    try {
      return await fn();
    } finally {
      if (hadWindow) g.window = prevWindow;
      else delete g.window;
      if (hadDocument) g.document = prevDocument;
      else delete g.document;
    }
  } finally {
    release();
  }
}

/** Lazy, memoized: the module is imported once, but the DOM shim it needed to
 *  import under is never left on `globalThis` — see `withDomGlobals`. */
export function loadMermaid(): Promise<typeof import("mermaid").default> {
  mermaidPromise ??= withDomGlobals(async () => {
    const mod = await import("mermaid");
    mod.default.initialize({ startOnLoad: false });
    return mod.default;
  });
  return mermaidPromise;
}

const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

export type MermaidFence = { start: number; end: number; fenceChar: string; body: string };

/** Every top-level fence in a document (0-based line indices), whatever its
 *  info string. Used to find the matching close of ANY fence — including one
 *  that is not a Mermaid diagram — so a longer fence's content is skipped
 *  wholesale rather than scanned into. */
function allFences(
  lines: string[],
): { start: number; end: number; marker: string; info: string }[] {
  const fences: { start: number; end: number; marker: string; info: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = FENCE_OPEN_RE.exec(lines[i] ?? "");
    if (m === null) {
      i++;
      continue;
    }
    const marker = m[2] ?? "```";
    const markerChar = marker[0] ?? "`";
    const info = (m[3] ?? "").trim();
    const closeRe = new RegExp(`^\\s*[${markerChar}]{${marker.length},}\\s*$`);
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j] ?? "")) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      i++; // unterminated fence — leave it, keep scanning
      continue;
    }
    fences.push({ start: i, end, marker, info });
    i = end + 1; // skip the whole fence — content nested inside is never re-scanned
  }
  return fences;
}

/** Every ` ```mermaid ` fence in a document, tracking generic fences too so a
 *  `mermaid` example nested inside a longer fence is not mistaken for a real
 *  diagram. Line indices are 0-based, `end` is the closing-fence line. */
export function extractMermaidFences(markdown: string): MermaidFence[] {
  const lines = markdown.split("\n");
  return allFences(lines)
    .filter((f) => f.info === "mermaid")
    .map((f) => ({
      start: f.start,
      end: f.end,
      fenceChar: f.marker,
      body: lines.slice(f.start + 1, f.end).join("\n"),
    }));
}

/** Fences that fail to parse with the real Mermaid parser. */
export async function findInvalidMermaidFences(markdown: string): Promise<MermaidFence[]> {
  const fences = extractMermaidFences(markdown);
  if (fences.length === 0) return [];
  const mermaid = await loadMermaid();
  const invalid: MermaidFence[] = [];
  for (const fence of fences) {
    try {
      await withDomGlobals(() => mermaid.parse(fence.body));
    } catch {
      invalid.push(fence);
    }
  }
  return invalid;
}

/** Rewrite each invalid fence (bottom-up, so earlier line indices stay valid)
 *  to a plain text fence carrying the original content, preceded by a comment
 *  recording the failure — mirrors openwiki's own degrade-in-place behavior. */
export async function degradeInvalidMermaidFences(markdown: string): Promise<string> {
  const invalid = await findInvalidMermaidFences(markdown);
  if (invalid.length === 0) return markdown;
  const lines = markdown.split("\n");
  for (const fence of invalid.toSorted((a, b) => b.start - a.start)) {
    const replacement = [
      "<!-- claude producer: mermaid parse failed, degraded to text -->",
      `${fence.fenceChar}text`,
      fence.body,
      fence.fenceChar,
    ];
    lines.splice(fence.start, fence.end - fence.start + 1, ...replacement);
  }
  return lines.join("\n");
}

/**
 * Deterministic post-authoring pass for the `claude` producer, run after the
 * agent completes and before the run reports its outcome.
 */
export async function finalizeClaudeBundle(bundleDir: string): Promise<void> {
  await syncIndexes(bundleDir);
  await degradeAllMermaidFences(bundleDir);
}

async function degradeAllMermaidFences(bundleDir: string): Promise<void> {
  // Reserved structural files (index.md, log.md, INSTRUCTIONS.md) are never
  // concept pages and are exempt everywhere else in the bundle (verify.ts,
  // grounding.ts, acceptance.ts) — exempt here too, so this pass can't rewrite
  // openwiki's wiki-goal input or a producer's own changelog.
  const files = (await walkMd(bundleDir)).filter(
    (f) => !RESERVED_NAMES.has(f.split("/").at(-1) ?? ""),
  );
  for (const rel of files) {
    const file = join(bundleDir, rel);
    const raw = await readFile(file, "utf8");
    const parsed = matter(raw, NO_MATTER_CACHE);
    const degradedBody = await degradeInvalidMermaidFences(parsed.content);
    if (degradedBody === parsed.content) continue;
    const rebuilt =
      Object.keys(parsed.data).length > 0
        ? matter.stringify(degradedBody, parsed.data)
        : degradedBody;
    await writeFile(file, rebuilt);
  }
}
