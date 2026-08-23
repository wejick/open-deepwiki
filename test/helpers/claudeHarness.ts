import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "../../src/producer/claude.ts";
import { CLAUDE_PROBES, WRITE_PAGE, writeShim } from "./shim.ts";
import { makeTmp, rmTmp } from "./tmp.ts";
import { createGitRepo } from "./gitFixture.ts";

let tmpDirs: string[] = [];

/** A fresh data dir plus an empty checkout inside it; removed by `cleanupTmps`,
 *  which each test file registers as its own `afterEach`. */
export async function checkout(): Promise<{ dir: string; checkout: string }> {
  const dir = await makeTmp();
  tmpDirs.push(dir);
  const c = join(dir, "checkout");
  await mkdir(c, { recursive: true });
  return { dir, checkout: c };
}

export async function cleanupTmps(): Promise<void> {
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
}

/** Register a tmpdir made outside `checkout` for `cleanupTmps` to remove. */
export function trackTmp(dir: string): void {
  tmpDirs.push(dir);
}

export function sessionRecord(over: Partial<Session> = {}): Session {
  return {
    outcome: "ok",
    resetAt: null,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    spawnError: null,
    ...over,
  };
}

/** One log line per session: `plan`, or `page:<path>`. */
export const sessionLog = (out: string): string[] => [
  `if [ -n "$PLAN_FILE" ]; then echo plan >> '${out}'; fi`,
  `if [ -n "$PAGE_PATH" ]; then echo "page:$PAGE_PATH" >> '${out}'; fi`,
];

/** A plan entry the pool shims write out of their prompts. */
export const pageEntry = (path: string) => ({
  path,
  type: "concept",
  title: path,
  brief: "b",
  sourcePaths: [],
  relatedPages: [],
});

/** Peak sessions in flight, read off the start/end marker log. */
export const peakInFlight = async (log: string): Promise<number> => {
  let inflight = 0;
  let peak = 0;
  for (const line of (await readFile(log, "utf8")).trim().split("\n")) {
    if (line === "") continue;
    inflight += line.startsWith("start:") ? 1 : -1;
    peak = Math.max(peak, inflight);
  }
  return peak;
};

/** A git checkout of 4 documentable files — enough to split at threshold 2, with
 * a sizing of budget 1 / expected 4 areas (accepted 2–8). */
export async function gitCheckout(): Promise<{ dir: string; checkout: string }> {
  const { dir, checkout: c } = await checkout();
  await createGitRepo(c, {
    "f0.ts": "a",
    "f1.ts": "b",
    "f2.ts": "c",
    "f3.ts": "d",
  });
  return { dir, checkout: c };
}

export const SPLIT_AREAS = [0, 1, 2, 3].map((i) => ({
  id: `a${i}`,
  paths: [`f${i}.ts`],
  pages: [`area${i}.md`],
}));
export const AREA_PAGE_JOBS = ["area0.md", "area1.md", "area2.md", "area3.md", "overview.md"];

/** The map phase's guidance, frontmatter stripped and whitespace collapsed —
 *  prose re-wraps freely, so assertions match on normalized text (the same
 *  text `phaseSection("map")` injects, modulo line breaks). */
export async function mapGuidance(): Promise<string> {
  const raw = await readFile(
    join(import.meta.dir, "../../src/producer/skill/skills/okf-wiki/MAP.md"),
    "utf8",
  );
  return raw
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits a recorded prompt/struct file (`== header ==` blocks) by header. */
export function promptBlocks(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^== (.*) ==$/.exec(line);
    if (m !== null) {
      key = m[1] ?? null;
      if (key !== null && out[key] === undefined) out[key] = "";
      continue;
    }
    if (key !== null && out[key] !== undefined) out[key] = `${out[key]}${line}\n`;
  }
  return out;
}

/** A `claude` shim that records, per session, the allowed-tools token, the
 *  prompt, and — for an area session — the structure handout file it was
 *  pointed at. `areaCount` splits into `a0`…`a<N-1>` single-file areas
 *  (`f<i>.ts`, matching `gitCheckout`); omit it to run the undecomposed
 *  planner, which writes `planPages`. */
export function claudeRecordingShim(opts: {
  areaCount?: number;
  planPages?: string[];
  tools: string;
  prompts: string;
  structs: string;
}): Promise<string> {
  const areas = Array.from({ length: opts.areaCount ?? 0 }, (_, i) => ({
    id: `a${i}`,
    paths: [`f${i}.ts`],
  }));
  const mapJson = JSON.stringify({
    areas: areas.map((a) => ({
      id: a.id,
      title: a.id,
      scope: `the ${a.id} area`,
      paths: a.paths,
    })),
  });
  const planJson = JSON.stringify({
    pages: (opts.planPages ?? []).map((path) => ({
      path,
      type: "concept",
      title: path,
      brief: "b",
      sourcePaths: [],
      relatedPages: [],
    })),
    deletePages: [],
  });
  const ok = JSON.stringify({
    is_error: false,
    terminal_reason: "completed",
    result: "done",
  });
  /** Logs one session: kind + allowed tools, and its prompt under a header. */
  const record = (varName: string, kind: string, header: string): string =>
    `if [ -n "$${varName}" ]; then echo "${kind} $TOOLS" >> '${opts.tools}'; echo "== ${header} ==" >> '${opts.prompts}'; echo "$PROMPT" >> '${opts.prompts}'; fi`;
  const areaCases =
    areas.length === 0
      ? []
      : [
          'if [ -n "$AREA_ID" ]; then',
          `  STRUCT=$(printf '%s\\n' "$PROMPT" | sed -n 's/^Structure handout for the paths this area owns: \\([^ ]*\\).*/\\1/p' | head -1)`,
          `  if [ -n "$STRUCT" ]; then printf '\\n' >> '${opts.structs}'; echo "== $AREA_ID ==" >> '${opts.structs}'; cat "$STRUCT" >> '${opts.structs}'; fi`,
          '  P="area${AREA_ID#a}.md"',
          '  printf \'%s\' "{\\"pages\\":[{\\"path\\":\\"$P\\",\\"type\\":\\"concept\\",\\"title\\":\\"$P\\",\\"brief\\":\\"b\\",\\"sourcePaths\\":[],\\"relatedPages\\":[]}]}" > "$PART_FILE"',
          `  cat <<'JSON'\n${ok}\nJSON`,
          "  exit 0",
          "fi",
        ];
  return writeShim(
    "claude",
    [
      ...CLAUDE_PROBES,
      'PROMPT="$2"',
      `MAP_FILE=$(printf '%s\\n' "$PROMPT" | sed -n 's/^MAP_FILE: //p' | head -1)`,
      `AREA_ID=$(printf '%s\\n' "$PROMPT" | sed -n 's/^AREA_ID: //p' | head -1)`,
      `PART_FILE=$(printf '%s\\n' "$PROMPT" | sed -n 's/^PART_FILE: //p' | head -1)`,
      `PLAN_FILE=$(printf '%s\\n' "$PROMPT" | sed -n 's/^PLAN_FILE: //p' | head -1)`,
      `PAGE_PATH=$(printf '%s\\n' "$PROMPT" | sed -n 's/^PAGE_PATH: //p' | head -1)`,
      // The token after --allowedTools, for the per-session-kind policy.
      'TOOLS=""',
      '_prev=""',
      'for _a in "$@"; do [ "$_prev" = "--allowedTools" ] && TOOLS="$_a"; _prev="$_a"; done',
      "mkdir -p ./openwiki",
      record("MAP_FILE", "map", "map"),
      record("AREA_ID", "area", "$AREA_ID"),
      record("PLAN_FILE", "plan", "plan"),
      `if [ -n "$PAGE_PATH" ]; then echo "page:$PAGE_PATH $TOOLS" >> '${opts.tools}'; fi`,
      ...(areas.length === 0
        ? []
        : [
            'if [ -n "$MAP_FILE" ]; then',
            `  printf '%s' '${mapJson}' > "$MAP_FILE"`,
            `  cat <<'JSON'\n${ok}\nJSON`,
            "  exit 0",
            "fi",
          ]),
      ...areaCases,
      'if [ -n "$PLAN_FILE" ]; then',
      `  printf '%s' '${planJson}' > "$PLAN_FILE"`,
      `  cat <<'JSON'\n${ok}\nJSON`,
      "  exit 0",
      "fi",
      'if [ -n "$PAGE_PATH" ]; then',
      '  mkdir -p "$(dirname "./openwiki/$PAGE_PATH")"',
      WRITE_PAGE,
      "fi",
      `cat <<'JSON'\n${ok}\nJSON`,
      "exit 0",
    ].join("\n"),
  );
}
