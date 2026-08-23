import type { Config } from "../config/config.ts";
import { globMatch } from "./crawl.ts";

/**
 * Lexical search via ripgrep (3.5): one `rg` invocation per query with term
 * alternation and JSON match attribution. No FTS, no BM25 — ranking is
 * distinct-term coverage (primary) × hit density (tiebreak).
 *
 * Group semantics: each keyword entry is one OR-alternative in the pattern;
 * within an entry, whitespace-separated terms are ANDed (an entry counts as
 * satisfied only when every term matched in the file); coverage = satisfied
 * entries / total entries.
 */

export type LexOptions = {
  mode: "auto" | "literal" | "regex";
  /** Keyword groups (each entry: one or more whitespace-separated terms). */
  entries?: string[][];
  query: string;
};

export type LexFile = {
  path: string; // absolute file path
  matches: number;
  coverage: number; // satisfied entries / total entries
  density: number; // matches / unique matched lines
  lines: number[];
};

export type LexResult = {
  files: LexFile[];
  available: boolean;
  warning: string | null;
};

const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by can did do does for from get got has have had he her hers him his how i if in into is it its just made make makes me more most my new no nor not now of on only or other our ours out over own same she so some such than that the their them then there these they this those to too under until up use used uses using very was we were what when where which while who why will with work would you your yours" +
    " also don should here once again further each few both any all"
  ).split(" "),
);

/** Deterministic fallback extraction: stopword drop, ≤4 longest tokens. */
export function extractTerms(query: string): string[][] {
  const tokens = (query.toLowerCase().match(/[a-z0-9_$-]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
  const unique = [...new Set(tokens)].toSorted((a, b) => b.length - a.length || a.localeCompare(b));
  return unique.slice(0, 4).map((t) => [t]);
}

/** Identifier variant expansion (auto mode): camel/snake/kebab/Pascal. */
export function expandVariants(token: string): string[] {
  if (!/[A-Z]|_|-/.test(token)) return [token];
  const words = token
    .replace(/-/g, "_")
    .split(/[_\s]|(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
  const camel = words
    .map((w, i) => (i === 0 ? w : `${w[0]?.toUpperCase() ?? ""}${w.slice(1)}`))
    .join("");
  const pascal = words.map((w) => `${w[0]?.toUpperCase() ?? ""}${w.slice(1)}`).join("");
  const snake = words.join("_");
  const kebab = words.join("-");
  return [...new Set([token, camel, pascal, snake, kebab])];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Plan = {
  pattern: string;
  fixedStrings: boolean;
  /** lowercased variant -> flat term index (for group coverage). */
  variantToTerm: Map<string, number>;
  /** flat term index -> keyword entry index. */
  termToEntry: number[];
  /** terms per entry (ANDed within an entry). */
  entrySize: number[];
  totalEntries: number;
  /** False for literal/regex modes (any match satisfies the single entry). */
  attributable: boolean;
  note: string | null;
};

function singleTermPlan(query: string, fixedStrings: boolean, note: string | null): Plan {
  return {
    pattern: query,
    fixedStrings,
    variantToTerm: new Map([[query.toLowerCase(), 0]]),
    termToEntry: [0],
    entrySize: [1],
    totalEntries: 1,
    attributable: false,
    note,
  };
}

function buildPlan(lex: LexOptions): Plan {
  if (lex.mode === "literal") {
    return singleTermPlan(lex.query, true, null);
  }
  if (lex.mode === "regex") {
    try {
      RegExp(lex.query);
    } catch {
      return singleTermPlan(lex.query, true, "invalid regex — fell back to fixed-string matching");
    }
    return singleTermPlan(lex.query, false, null);
  }
  // auto mode
  const entries = lex.entries ?? extractTerms(lex.query);
  const variantToTerm = new Map<string, number>();
  const termToEntry: number[] = [];
  const entrySize: number[] = [];
  const alternatives: string[] = [];
  entries.forEach((entry, entryIdx) => {
    entrySize.push(entry.length);
    for (const term of entry) {
      for (const variant of lex.entries ? [term] : expandVariants(term)) {
        const key = variant.toLowerCase();
        if (!variantToTerm.has(key)) {
          variantToTerm.set(key, termToEntry.length);
          termToEntry.push(entryIdx);
          alternatives.push(escapeRegex(variant));
        }
      }
    }
  });
  return {
    pattern: alternatives.join("|"),
    fixedStrings: false,
    variantToTerm,
    termToEntry,
    entrySize,
    totalEntries: entries.length,
    attributable: true,
    note: null,
  };
}

/**
 * Path each matched file is glob-checked against: relative to its own root
 * dir (longest prefix wins), so a bundle page is judged as `overview`, not as
 * `<checkout>/openwiki/overview`. rg matches its `-g` globs against the path
 * as printed — absolute roots defeat basename/dir globs (rg >= 14) — so the
 * `-g` args are only a cheap pre-filter and this rel-path check is the
 * authority, keeping lexical results consistent with the crawler.
 */
function relForGlobMatch(absPath: string, dirs: string[]): string {
  let best = "";
  for (const d of dirs) {
    const prefix = d.endsWith("/") ? d : `${d}/`;
    if (absPath.startsWith(prefix) && prefix.length > best.length) best = prefix;
  }
  return best !== "" ? absPath.slice(best.length) : absPath.replace(/^\.\//, "");
}

export async function lexicalSearch(
  cfg: Config,
  opts: { dirs: string[]; lex: LexOptions; env?: Record<string, string>; timeoutMs?: number },
): Promise<LexResult> {
  const plan = buildPlan(opts.lex);
  if (plan.pattern === "") return { files: [], available: true, warning: null };

  const args = ["--json", "--no-heading", "-i", "--max-count", String(cfg.rgMaxCountPerFile)];
  if (cfg.maxFileSizeBytes > 0) args.push("--max-filesize", String(cfg.maxFileSizeBytes));
  for (const g of cfg.excludeGlobs) args.push("-g", `!${g}`);
  for (const g of cfg.includeGlobs) if (g !== "*" && g !== "**") args.push("-g", g);
  if (plan.fixedStrings) args.push("-F");
  args.push("--", plan.pattern, ...opts.dirs);

  const timeoutMs = opts.timeoutMs ?? cfg.rgTimeoutMs;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...opts.env,
  };

  let proc;
  try {
    proc = Bun.spawn(["rg", ...args], { env, stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    if (/not found in \$PATH|ENOENT|failed to spawn/i.test(String(err))) {
      return { files: [], available: false, warning: "rg not found — lexical search disabled" };
    }
    return { files: [], available: false, warning: String(err) };
  }

  let timedOut = false;
  let settled: () => void;
  const done = new Promise<void>((r) => {
    settled = r;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
    settled();
  }, timeoutMs);
  proc.exited.catch(() => {}).then(() => settled());
  await done;
  clearTimeout(timer);

  if (timedOut) {
    return {
      files: [],
      available: false,
      warning: "rg timed out — degraded to vector-only search",
    };
  }
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    // exit 1 = no matches (normal); anything else is an error (e.g. bad pattern)
    const err = await new Response(proc.stderr).text();
    if (proc.exitCode === 2) {
      return { files: [], available: false, warning: `rg error: ${err.slice(0, 200)}` };
    }
  }

  const stdout = await new Response(proc.stdout).text();
  const perFile = new Map<
    string,
    { terms: Map<number, number>; lines: Set<number>; matches: number }
  >();

  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    let event: {
      type?: string;
      data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
        submatches?: { match?: { text?: string } }[];
      };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "match") continue;
    const filePath = event.data?.path?.text;
    const lineNo = event.data?.line_number;
    if (!filePath || lineNo === undefined) continue;

    let rec = perFile.get(filePath);
    if (!rec) {
      rec = { terms: new Map(), lines: new Set(), matches: 0 };
      perFile.set(filePath, rec);
    }
    rec.lines.add(lineNo);
    rec.matches++;
    const sub = event.data?.submatches?.[0]?.match?.text;
    if (sub !== undefined && plan.attributable) {
      const termIdx = plan.variantToTerm.get(sub.toLowerCase());
      if (termIdx !== undefined) rec.terms.set(termIdx, (rec.terms.get(termIdx) ?? 0) + 1);
    }
  }

  const files: LexFile[] = [];
  for (const [path, rec] of perFile) {
    // Authority over the `-g` args: drop files whose repo-relative path an
    // exclude glob matches, exactly as the crawler would (rg's own glob
    // matching is relative to the printed path, not the checkout).
    if (cfg.excludeGlobs.some((g) => globMatch(g, relForGlobMatch(path, opts.dirs)))) continue;
    let satisfied: number;
    if (!plan.attributable) {
      satisfied = rec.lines.size > 0 ? 1 : 0;
    } else {
      // Entry satisfied iff every one of its terms matched in this file.
      satisfied = 0;
      for (let e = 0; e < plan.totalEntries; e++) {
        const matchedInEntry = [...rec.terms.keys()].filter(
          (t) => plan.termToEntry[t] === e,
        ).length;
        if (matchedInEntry >= (plan.entrySize[e] ?? 1)) satisfied++;
      }
    }
    files.push({
      path,
      matches: rec.matches,
      coverage: satisfied / Math.max(1, plan.totalEntries),
      density: rec.matches / Math.max(1, rec.lines.size),
      lines: [...rec.lines].toSorted((a, b) => a - b),
    });
  }

  // Coverage outranks raw hit count; density breaks ties.
  const sorted = files.toSorted(
    (a, b) =>
      b.coverage - a.coverage ||
      b.density - a.density ||
      b.matches - a.matches ||
      a.path.localeCompare(b.path),
  );

  return { files: sorted, available: true, warning: plan.note };
}
