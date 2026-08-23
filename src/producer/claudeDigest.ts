import { stat } from "node:fs/promises";
import { globMatch } from "../index/crawl.ts";

/**
 * Deterministic repository digest for the planning sessions — the whole tracked
 * file tree grouped per directory, at no model cost, so planning sizes and
 * scopes from evidence instead of exploring. Pure function of the checkout's
 * `git ls-files` output plus per-file sizes; it is an input to a prompt, never
 * a bundle artifact. The tree is built once per init run and rendered whole
 * (map, undecomposed planner) or as an area-scoped slice, so no planning
 * session has to enumerate the tree itself with Glob calls.
 *
 * The documentable set is tracked files minus the non-documentable kinds minus
 * the merged exclude set (spec: okf-producer › Claude producer planning honors
 * the merged exclude set) — the same set the crawl and ripgrep honor, so the
 * mapper is never shown a tree the index already ignores.
 */

/** Bounded count of a directory's files the digest names, largest first. */
export const DIGEST_MAX_FILES_PER_DIR = 10;

/** One named file under a directory; `bytes` is its measured size. */
export type DigestFile = { name: string; bytes: number };

/** One directory's documentable files and their total size. */
export type DigestDir = { files: DigestFile[]; bytes: number };

/** The structured tree one init run renders its handouts from. */
export type DigestTree = {
  /** Directory (no trailing slash; `(root)` for files in the repo root). */
  dirs: Map<string, DigestDir>;
  documentableCount: number;
  /** Why tracked files were excluded, with counts — for the header's report. */
  excluded: Map<ExcludedKind, number>;
  /** Tracked files the merged exclude set removed, counted separately from
   *  the kind buckets because they are an operator rule, not a file kind. */
  globExcluded: number;
};

/** The tracked file list, one path per line, git's own (sorted) order. */
export async function listTrackedFiles(cwd: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-files"], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ls-files exited ${code}`);
  return out.split("\n").filter((l) => l !== "");
}

/** Why a tracked file is not documentable, or null when it is. The map may
 *  only own documentable files, so this predicate is the shared boundary for
 *  the digest, the sizing count and the validator: all three must agree or a
 *  mapper sized on the digest is charged a budget it was never shown. */
export type ExcludedKind = "media" | "lockfile" | "string catalog" | "generated" | "animation";

const MEDIA_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "avif",
  "heic",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  "mp3",
  "wav",
  "aac",
  "m4a",
  "mp4",
  "mov",
  "m4v",
  "webm",
  "zip",
  "gz",
  "tar",
  "jar",
  "pdf",
]);
const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "podfile.lock",
  "gemfile.lock",
  "cargo.lock",
  "go.sum",
  "poetry.lock",
  "composer.lock",
]);
const CATALOG_EXT = new Set(["strings", "stringsdict", "po", "pot"]);
const GENERATED_SEGMENTS = new Set(["node_modules", "pods", "deriveddata", ".gradle"]);

const extension = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
};

/** "media" and "generated" are their own plurals; the rest take an s. */
const plural = (kind: ExcludedKind, n: number): string =>
  kind === "media" || kind === "generated" ? kind : n === 1 ? kind : `${kind}s`;

export function nonDocumentableKind(path: string): ExcludedKind | null {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const ext = extension(lower);
  const base = segments[segments.length - 1] ?? "";
  if (segments.some((s) => GENERATED_SEGMENTS.has(s))) return "generated";
  if (LOCKFILES.has(base)) return "lockfile";
  if (MEDIA_EXT.has(ext)) return "media";
  if (CATALOG_EXT.has(ext)) return "string catalog";
  const stringsDir =
    segments.includes("strings") && (ext === "json" || ext === "xml") && segments.length > 1;
  if (stringsDir) return "string catalog";
  const animations =
    ext === "lottie" ||
    (ext === "json" && segments.some((s, i) => s === "assets" && segments[i + 1] === "animations"));
  if (animations) return "animation";
  return null;
}

/* ── protection classes for the map's exclusion gate ────────────────────────
 * An exclusion proposal is refused when any tracked file under it is one of
 * these — the three things a repo-level exclude must never silently remove.
 * Conservative by design: a false "protection" only costs a proposal, while a
 * false "data" costs code, docs, or config from the wiki and the index.
 */
export type ProtectionKind = "code" | "documentation" | "configuration";

const CODE_EXT = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "pyi",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "groovy",
  "swift",
  "m",
  "mm",
  "c",
  "h",
  "cpp",
  "cc",
  "hpp",
  "cs",
  "php",
  "dart",
  "vue",
  "svelte",
  "ex",
  "exs",
  "erl",
  "hrl",
  "hs",
  "ml",
  "clj",
  "cljs",
  "lua",
  "pl",
  "pm",
  "r",
  "jl",
  "nim",
  "zig",
  "v",
  "sv",
  "sh",
  "bash",
  "zsh",
  "fish",
  "bat",
  "ps1",
  "sql",
  "proto",
  "graphql",
  "gql",
  "sol",
  "tf",
  "tfvars",
]);
const DOC_EXT = new Set(["md", "mdx", "rst", "adoc", "asciidoc", "org", "txt"]);
const CONFIG_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "Podfile",
  "composer.json",
  "pom.xml",
  "Makefile",
  "CMakeLists.txt",
  "Dockerfile",
  "tox.ini",
  "pytest.ini",
  ".npmrc",
  ".nvmrc",
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
]);
/** `vite.config.ts`, `config.json`, `app.config.production.yaml` — the stem
 *  carries "config" as a delimited token. `Contents.json` does not match. */
const CONFIG_STEM = /(^|[-_.])config([-_.]|$)/;

/** Why a tracked file must never sit under an exclusion proposal, or null when
 *  it is inert data by this reading. Pure, like `nonDocumentableKind` beside
 *  it — the map gate's safety half (spec: okf-producer › Claude producer map
 *  exclusion gate). */
export function protectionReason(path: string): ProtectionKind | null {
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? "";
  const ext = extension(base);
  if (CODE_EXT.has(ext)) return "code";
  if (DOC_EXT.has(ext)) return "documentation";
  if (base.startsWith(".env")) return "configuration";
  if (CONFIG_NAMES.has(base)) return "configuration";
  const dot = base.lastIndexOf(".");
  const stem = dot === -1 ? base : base.slice(0, dot);
  if (ext !== "" && CONFIG_STEM.test(stem)) return "configuration";
  return null;
}

/** The tracked files the map may own: everything except the excluded kinds
 *  and the merged exclude set's matches. */
export async function listDocumentableFiles(
  cwd: string,
  excludeGlobs: string[] = [],
): Promise<string[]> {
  const all = await listTrackedFiles(cwd);
  return all.filter(
    (f) => !excludeGlobs.some((g) => globMatch(g, f)) && nonDocumentableKind(f) === null,
  );
}

const dirOf = (file: string): string =>
  file.includes("/") ? `${file.slice(0, file.lastIndexOf("/"))}/` : "(root)";

/** The whole tree in one pass: tracked files classified, grouped per
 *  directory, each file stat'ed. A file that vanished mid-read contributes no
 *  bytes and still names the tree. */
export async function buildDigestTree(
  cwd: string,
  excludeGlobs: string[] = [],
): Promise<DigestTree> {
  const files = await listTrackedFiles(cwd);
  const excluded = new Map<ExcludedKind, number>();
  let globExcluded = 0;
  const documentable: string[] = [];
  for (const f of files) {
    if (excludeGlobs.some((g) => globMatch(g, f))) {
      globExcluded++;
      continue;
    }
    const kind = nonDocumentableKind(f);
    if (kind === null) documentable.push(f);
    else excluded.set(kind, (excluded.get(kind) ?? 0) + 1);
  }
  const dirs = new Map<string, DigestDir>();
  for (const f of documentable) {
    if (!dirs.has(dirOf(f))) dirs.set(dirOf(f), { files: [], bytes: 0 });
  }
  for (const f of documentable) {
    const d = dirs.get(dirOf(f));
    if (d === undefined) continue;
    const bytes = await stat(`${cwd}/${f}`)
      .then((s) => s.size)
      .catch(() => 0);
    d.files.push({ name: f.slice(f.lastIndexOf("/") + 1), bytes });
    d.bytes += bytes;
  }
  return { dirs, documentableCount: documentable.length, excluded, globExcluded };
}

/** Size desc, then name asc — stable, and "largest first" as the guidance
 *  promises so the digest's named files are the load-bearing ones. */
function sortFiles(files: DigestFile[]): DigestFile[] {
  return [...files].toSorted(
    (a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/** One directory's lines: the count/size line the digest always carried, then
 *  up to `maxFiles` named files and a marker for the rest. */
function dirLines(dir: string, d: DigestDir, maxFiles: number): string[] {
  const files = sortFiles(d.files);
  const lines = [`${dir}  ${files.length} files  ${d.bytes} bytes`];
  for (const f of files.slice(0, maxFiles)) lines.push(`  - ${f.name} (${f.bytes} bytes)`);
  if (files.length > maxFiles) lines.push(`  - … and ${files.length - maxFiles} more files`);
  return lines;
}

function sortDirs(dirs: Array<[string, DigestDir]>): Array<[string, DigestDir]> {
  return dirs.toSorted((a, b) => {
    const byCount = b[1].files.length - a[1].files.length;
    if (byCount !== 0) return byCount;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
}

const excludedReport = (tree: DigestTree): string => {
  const parts = [...tree.excluded.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${n} ${plural(kind, n)}`);
  if (tree.globExcluded > 0) parts.push(`${tree.globExcluded} by exclude globs`);
  const total = [...tree.excluded.values()].reduce((a, b) => a + b, 0) + tree.globExcluded;
  if (total === 0) return "";
  return ` (${total} excluded: ${parts.join(", ")})`;
};

/** The whole-tree handout: header plus each directory's lines, directories
 *  largest-first and capped — the same shape `repoDigest` always rendered,
 *  now naming each directory's files. */
export function renderDigest(
  tree: DigestTree,
  maxDirs = 400,
  maxFiles = DIGEST_MAX_FILES_PER_DIR,
): string {
  const dirs = sortDirs([...tree.dirs.entries()]);
  const omitted = Math.max(0, dirs.length - maxDirs);
  const lines = [
    `Documentable files: ${tree.documentableCount}${excludedReport(tree)}`,
    `Directories: ${tree.dirs.size}${omitted > 0 ? ` (showing ${maxDirs}, ${omitted} smaller omitted)` : ""}`,
  ];
  for (const [dir, d] of dirs.slice(0, maxDirs)) lines.push(...dirLines(dir, d, maxFiles));
  return lines.join("\n");
}

/** `.` names the repo root's own files, a directory its subtree, a file
 *  itself — the same scope semantics the map's ownership helpers use. A
 *  trailing slash is tolerated, as in the map's own path forms. */
function scopeOwns(scope: string, path: string): boolean {
  const p = scope.length > 1 && scope.endsWith("/") ? scope.slice(0, -1) : scope;
  if (p === ".") return !path.includes("/");
  return path === p || path.startsWith(`${p}/`);
}

/** One planning area's handout: the directories holding files under its owned
 *  scope paths, in the same per-directory format. Only owned files are named,
 *  so an overlapping area's slice never shows another area's structure. */
export function renderDigestSubset(
  tree: DigestTree,
  scopePaths: string[],
  maxFiles = DIGEST_MAX_FILES_PER_DIR,
): string {
  const dirs: Array<[string, DigestDir]> = [];
  for (const [dir, d] of tree.dirs) {
    const kept = d.files.filter((f) => {
      const path = dir === "(root)" ? f.name : `${dir}${f.name}`;
      return scopePaths.some((p) => scopeOwns(p, path));
    });
    if (kept.length === 0) continue;
    dirs.push([dir, { files: kept, bytes: kept.reduce((a, f) => a + f.bytes, 0) }]);
  }
  const lines: string[] = [];
  for (const [dir, d] of sortDirs(dirs)) lines.push(...dirLines(dir, d, maxFiles));
  return lines.join("\n");
}

/** The whole-tree digest text, for callers that do not keep the tree around. */
export async function repoDigest(
  cwd: string,
  maxDirs = 400,
  excludeGlobs: string[] = [],
): Promise<string> {
  return renderDigest(await buildDigestTree(cwd, excludeGlobs), maxDirs);
}
