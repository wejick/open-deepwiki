import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conceptPagePaths } from "../../src/producer/verify.ts";

/** A short executable in a tmpdir, prepended to PATH — the real spawn path,
 *  no module mocking. */

export async function writeShim(name: string, script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `odw-${name}-`));
  await Bun.write(join(dir, name), `#!/bin/sh\n${script}\n`);
  await chmod(join(dir, name), 0o755);
  return dir;
}

export function pathWith(...dirs: string[]): string {
  return [...dirs, process.env.PATH ?? "/usr/bin:/bin"].join(":");
}

export const VERSION_LINE = 'echo "OpenWiki v0.3.4"';

/** openwiki shim that reports a version and copies a fixture bundle into `./openwiki/`. */
export function openwikiHappy(bundleDir: string): Promise<string> {
  return writeShim(
    "openwiki",
    [
      'if [ "$1" = "--help" ]; then echo "OpenWiki v0.3.4"; exit 0; fi',
      "mkdir -p ./openwiki",
      `cp -r '${bundleDir}/.' ./openwiki/`,
      "exit 0",
    ].join("\n"),
  );
}

/** openwiki shim that fails every real run (still answers --help). */
export function openwikiExit1(): Promise<string> {
  return writeShim(
    "openwiki",
    [
      'if [ "$1" = "--help" ]; then echo "OpenWiki v0.3.4"; exit 0; fi',
      'echo "openwiki exploded" >&2',
      "exit 1",
    ].join("\n"),
  );
}

export function openwikiExit1Noisy(lines: number): Promise<string> {
  return writeShim(
    "openwiki",
    [
      'if [ "$1" = "--help" ]; then echo "OpenWiki v0.3.4"; exit 0; fi',
      `for i in $(seq 1 ${lines}); do echo "stderr line $i" >&2; done`,
      'echo "the last word" >&2',
      "exit 1",
    ].join("\n"),
  );
}

/** openwiki shim that hangs forever on real runs (timeout path). */
export function openwikiHang(): Promise<string> {
  return writeShim(
    "openwiki",
    ['if [ "$1" = "--help" ]; then echo "OpenWiki v0.3.4"; exit 0; fi', "sleep 1"].join("\n"),
  );
}

/** A PATH with no `rg` (and no system PATH) — degradation tests. */
export async function pathWithoutRg(...shimDirs: string[]): Promise<string> {
  const empty = await mkdtemp(join(tmpdir(), "odw-empty-"));
  return [empty, ...shimDirs].join(":");
}

/* ── claude producer shims ─────────────────────────────────────────────────
 * The real CLI runs once, in the gated live spike. These cover every outcome
 * offline, using payload shapes the spike actually observed.
 */

const CLAUDE_OK = JSON.stringify({
  is_error: false,
  terminal_reason: "completed",
  subtype: "success",
  num_turns: 9,
  total_cost_usd: 0.27,
  result: "Wrote the bundle to ./openwiki/.",
});

export const CLAUDE_PROBES = [
  'if [ "$1" = "--version" ]; then echo "2.1.228 (Claude Code)"; exit 0; fi',
  [
    'if [ "$1" = "--help" ]; then',
    '  echo "  --setting-sources <sources>  Comma-separated list"',
    '  echo "  -r, --resume [value]  Resume a conversation by session ID"',
    '  echo "  --session-id <uuid>  Use a specific session ID for the conversation"',
    "  exit 0",
    "fi",
  ].join("\n"),
];

export const CLAUDE_PROBES_LEGACY = [
  'if [ "$1" = "--version" ]; then echo "2.0.9 (Claude Code)"; exit 0; fi',
  'if [ "$1" = "--help" ]; then echo "  --allowedTools <tools...>"; exit 0; fi',
];

/** Reads `--session-id`/`--resume` out of the argv, so a test can assert which
 *  sessions were named, which were resumed — and which were neither. */
const SESSION_CAPTURE = [
  'SESS_MODE=""',
  'SESS_ID=""',
  '_prev=""',
  'for _a in "$@"; do',
  '  if [ "$_prev" = "--session-id" ]; then SESS_MODE="new"; SESS_ID="$_a"; fi',
  '  if [ "$_prev" = "--resume" ]; then SESS_MODE="resume"; SESS_ID="$_a"; fi',
  '  _prev="$_a"',
  "done",
  'if [ -n "$SESS_MODE" ] && [ -n "$ODW_SESSION_FLAGS_OUT" ]; then',
  '  echo "$SESS_MODE $SESS_ID" >> "$ODW_SESSION_FLAGS_OUT"',
  "fi",
].join("\n");

/** Proves the producer's ordering from inside the child: a fresh session's
 *  identity and a resume's identity are both already in the sidecar by the
 *  time the session runs — recorded before the spawn, never after. */
const SESSION_SIDECAR_CHECK = [
  'if [ -n "$SESS_MODE" ] && [ -n "$ODW_SESSION_CHECKS_OUT" ]; then',
  '  if grep -q "$SESS_ID" ./openwiki/.odw-sessions.json 2>/dev/null; then',
  '    echo "$SESS_MODE:recorded:$PAGE_PATH" >> "$ODW_SESSION_CHECKS_OUT"',
  "  else",
  '    echo "$SESS_MODE:unrecorded:$PAGE_PATH" >> "$ODW_SESSION_CHECKS_OUT"',
  "  fi",
  "fi",
].join("\n");

/** A conformant page at `$PAGE_PATH` — enough for its job to count as done. */
export const WRITE_PAGE =
  'printf -- "---\\ntype: concept\\ntitle: Page\\ndescription: Assigned page.\\n---\\n\\nBody.\\n" > "./openwiki/$PAGE_PATH"';

const WRITE_PAGE_IF_MISSING = `if [ ! -f "./openwiki/$PAGE_PATH" ]; then ${WRITE_PAGE}; fi`;

function planJson(pages: string[], deletePages: string[]): string {
  return JSON.stringify({
    pages: pages.map((path) => ({
      path,
      type: "module",
      title: path.replace(/\.md$/, ""),
      brief: `Everything the bundle records about ${path}.`,
      sourcePaths: [],
      relatedPages: [],
    })),
    deletePages,
  });
}

/** Shell `if` lines around an optional body: nothing when the body is absent. */
function branch(guard: string, body: string[] | undefined): string[] {
  return body === undefined ? [] : [guard, ...body, "fi"];
}

/**
 * Assembles a `claude` shim from the session kinds one run has: a planning
 * session, one session per page, and the whole-bundle repair retry. Each
 * branches on the same directive line the model reads out of its prompt.
 */
export function claudeSessions(parts: {
  /** What the planning session writes to `PLAN_FILE`. */
  plan: string[];
  /** Pages the plan asks to remove — update runs only. */
  deletePages?: string[];
  /** A page session, with `$PAGE_PATH` set and its directory already made. */
  page?: string[];
  /** The repair retry: the session given neither directive. */
  repair?: string[];
  /** A page session and the repair retry alike, after the two above. */
  both?: string[];
  /** Before any branching, the planning session included. */
  first?: string[];
  payload?: string;
  /** The `--help`/`--version` banner; the default advertises the session
   *  flags, the legacy set (task: degrade) advertises neither. */
  probes?: string[];
}): Promise<string> {
  const report = `cat <<'JSON'\n${parts.payload ?? CLAUDE_OK}\nJSON`;
  return writeShim(
    "claude",
    [
      ...(parts.probes ?? CLAUDE_PROBES),
      'PROMPT="$2"',
      SESSION_CAPTURE,
      `PLAN_FILE=$(printf '%s\n' "$PROMPT" | sed -n 's/^PLAN_FILE: //p' | head -1)`,
      `PAGE_PATH=$(printf '%s\n' "$PROMPT" | sed -n 's/^PAGE_PATH: //p' | head -1)`,
      "mkdir -p ./openwiki",
      ...(parts.first ?? []),
      ...branch('if [ -n "$PLAN_FILE" ]; then', [
        `cat > "$PLAN_FILE" <<'PLAN'\n${planJson(parts.plan, parts.deletePages ?? [])}\nPLAN`,
        report,
        "exit 0",
      ]),
      ...branch('if [ -n "$PAGE_PATH" ]; then', [
        'mkdir -p "$(dirname "./openwiki/$PAGE_PATH")"',
        SESSION_SIDECAR_CHECK,
        ...(parts.page ?? []),
      ]),
      ...branch('if [ -z "$PAGE_PATH" ]; then', parts.repair),
      ...(parts.both ?? []),
      report,
      "exit 0",
    ].join("\n"),
  );
}

/** Happy path: plans the fixture's pages, copies the requested page per
 *  session; a prompt with neither directive is a repair retry. */
export async function claudeHappy(bundleDir: string): Promise<string> {
  return claudeSessions({
    plan: await conceptPagePaths(bundleDir),
    page: [
      `if [ -f '${bundleDir}/'"$PAGE_PATH" ]; then`,
      `  cp '${bundleDir}/'"$PAGE_PATH" "./openwiki/$PAGE_PATH"`,
      "else",
      // The inserted overview job, when a fixture predates it.
      '  printf -- "---\\ntype: overview\\ntitle: Overview\\ndescription: Entry point.\\n---\\n\\nEntry point for this bundle.\\n" > "./openwiki/$PAGE_PATH"',
      "fi",
    ],
    repair: [`cp -r '${bundleDir}/.' ./openwiki/`],
  });
}

/** Measured in the spike: exits 0 claiming completion, writes no bundle.
 *  Acceptance must reject this rather than trust it. */
export function claudeSuccessButEmpty(): Promise<string> {
  return writeShim(
    "claude",
    [...CLAUDE_PROBES, `cat <<'JSON'\n${CLAUDE_OK}\nJSON`, "exit 0"].join("\n"),
  );
}

/** Usage limit exhausted, carrying a reset time. */
export function claudeRateLimited(resetAt = "2026-09-01T12:00:00Z"): Promise<string> {
  const payload = JSON.stringify({
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 429,
    total_cost_usd: 0,
    result: `Usage limit reached. Limit resets at ${resetAt}`,
  });
  return writeShim(
    "claude",
    [...CLAUDE_PROBES, `cat <<'JSON'\n${payload}\nJSON`, "exit 1"].join("\n"),
  );
}

/** Rate limited with no machine-readable reset time. */
export function claudeRateLimitedNoReset(): Promise<string> {
  const payload = JSON.stringify({
    is_error: true,
    terminal_reason: "api_error",
    result: "You have exceeded your rate limit. Try again later.",
  });
  return writeShim(
    "claude",
    [...CLAUDE_PROBES, `cat <<'JSON'\n${payload}\nJSON`, "exit 1"].join("\n"),
  );
}

/** Not authenticated, presented as a clean-looking failure. */
export function claudeNotLoggedIn(): Promise<string> {
  const payload = JSON.stringify({
    is_error: true,
    terminal_reason: "api_error",
    total_cost_usd: 0,
    result: "Not logged in · Please run /login",
  });
  return writeShim(
    "claude",
    [...CLAUDE_PROBES, `cat <<'JSON'\n${payload}\nJSON`, "exit 1"].join("\n"),
  );
}

/** Emits a malformed bundle (missing frontmatter) but reports success. */
export function claudeMalformedBundle(): Promise<string> {
  return claudeSessions({
    plan: ["broken.md"],
    page: ['printf -- "no frontmatter at all\\n" > "./openwiki/$PAGE_PATH"'],
    repair: ['printf -- "no frontmatter at all\\n" > ./openwiki/broken.md'],
  });
}

/** Always leaves a bundle acceptance rejects, repair included — the
 *  "exhausted" case, unlike `claudeSuccessButEmpty`'s "produces nothing". */
export function claudeAlwaysUnacceptable(): Promise<string> {
  return claudeSessions({
    plan: ["page.md"],
    page: [WRITE_PAGE],
    // Written by the repair retry too, so nothing it does can be accepted.
    both: ['printf -- "no frontmatter\\n" > ./openwiki/broken.md'],
  });
}

export function claudeFailsOnePage(
  pages: string[],
  failOn: string,
  opts: { stderr?: string; noise?: string } = {},
): Promise<string> {
  return claudeSessions({
    plan: pages,
    ...(opts.noise === undefined ? {} : { first: [`echo ${JSON.stringify(opts.noise)} >&2`] }),
    page: [
      `if [ "$PAGE_PATH" = ${JSON.stringify(failOn)} ]; then`,
      `echo ${JSON.stringify(opts.stderr ?? "session exploded")} >&2`,
      "exit 2",
      "fi",
      WRITE_PAGE,
    ],
  });
}

/** Every page but one, whose session hangs past the step budget — the case
 *  per-page isolation exists for. */
export function claudeStallsOnOnePage(pages: string[], stallOn: string): Promise<string> {
  return claudeSessions({
    plan: pages,
    page: [
      `if [ "$PAGE_PATH" = ${JSON.stringify(stallOn)} ]; then sleep 30; exit 0; fi`,
      WRITE_PAGE,
    ],
  });
}

/** Produces exactly the page each session is assigned, and nothing else. */
export function claudePipelineHappy(pages: string[]): Promise<string> {
  return claudeSessions({
    plan: pages,
    page: [
      // Records the page order, for a one-session-per-page assertion.
      'if [ -n "$ODW_PAGES_OUT" ]; then echo "$PAGE_PATH" >> "$ODW_PAGES_OUT"; fi',
      WRITE_PAGE,
    ],
  });
}

/** Page sessions that signal `start:<path>`/`end:<path>` to a log with a
 *  hold before writing — a window into how many sessions were truly in flight,
 *  for the worker-pool cap and sequential-default assertions. */
export function claudePooledPages(pages: string[], log: string, holdSec = 0.4): Promise<string> {
  return claudeSessions({
    plan: pages,
    page: [
      `echo "start:$PAGE_PATH" >> '${log}'`,
      `sleep ${holdSec}`,
      WRITE_PAGE,
      `echo "end:$PAGE_PATH" >> '${log}'`,
    ],
  });
}

/** A page pool where one assigned page reports a usage limit while every other
 *  page session holds before writing. `partialPrefix` is written first by the
 *  peers, so a cancelled peer is observed mid-write (the resume case). */
export function claudeRateLimitedPool(opts: {
  pages: string[];
  /** The one page whose session reports the limit, ending the pool. */
  onPath: string;
  resetAt?: string;
  /** Non-conformant junk written before the hold, simulating a half-written file. */
  partialPrefix?: string;
  holdSec?: number;
}): Promise<string> {
  const resetAt = opts.resetAt ?? "2026-09-01T12:00:00Z";
  const payload = JSON.stringify({
    is_error: true,
    terminal_reason: "usage_limit",
    api_error_status: 429,
    result: `Usage limit reached. Resets at ${resetAt}.`,
  });
  return claudeSessions({
    plan: opts.pages,
    page: [
      `if [ "$PAGE_PATH" = ${JSON.stringify(opts.onPath)} ]; then`,
      // The limit fires only once every peer's prefix is on disk, so the
      // cancel cannot outrun the state the test asserts on.
      ...(opts.partialPrefix === undefined
        ? []
        : opts.pages
            .filter((p) => p !== opts.onPath)
            .map((p) => `until [ -f "./openwiki/${p}" ]; do sleep 0.02; done`)),
      `  cat <<'JSON'\n${payload}\nJSON`,
      "  exit 1",
      "fi",
      ...(opts.partialPrefix === undefined
        ? []
        : [`printf -- '${opts.partialPrefix}' > "./openwiki/$PAGE_PATH"`]),
      `sleep ${opts.holdSec ?? 30}`,
      WRITE_PAGE,
    ],
  });
}

/** Non-JSON stdout — a CLI whose output contract changed under us. */
export function claudeGarbageOutput(): Promise<string> {
  return writeShim("claude", [...CLAUDE_PROBES, 'echo "not json at all"', "exit 0"].join("\n"));
}

/** A page pool for the resume scenarios: what a session does depends on how
 *  it was invoked — fresh (`--session-id`) or resumed (`--resume`) — so one
 *  shim serves the interruption run, the resume that follows it, and the
 *  unresumable fallback. The refusal reproduces the measured CLI shape: a
 *  plain-text line on stdout, exit 1, no JSON. */
export function claudeResumePool(opts: {
  pages: string[];
  /** A resumed session: finish the page (default), report the usage limit
   *  again, refuse the resume, or fail terminally with a result payload. */
  onResume?: "write" | "rateLimit" | "unresumable" | "fail";
  /** A fresh session: finish the page (default) or stall past the step
   *  budget, so the run ends with the page unproduced. */
  onFresh?: "write" | "stall";
  /** Where each resumed session's full prompt is appended, for asserting the
   *  continuation contract (the PAGE_PATH header, the interruption note). */
  prompts?: string;
}): Promise<string> {
  const onResume = opts.onResume ?? "write";
  const onFresh = opts.onFresh ?? "write";
  const rateLimitPayload = JSON.stringify({
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 429,
    result: "Usage limit reached. Resets at 2026-09-01T12:00:00Z.",
  });
  const failPayload = JSON.stringify({
    is_error: true,
    terminal_reason: "api_error",
    result: "The model is overloaded. Try again.",
  });
  return claudeSessions({
    plan: opts.pages,
    ...(opts.prompts === undefined
      ? {}
      : {
          first: [
            `if [ "$SESS_MODE" = "resume" ] && [ -n "$PAGE_PATH" ]; then`,
            `  printf '%s\\n' "== $PAGE_PATH ==" >> '${opts.prompts}'`,
            `  printf '%s\\n' "$PROMPT" >> '${opts.prompts}'`,
            "fi",
          ],
        }),
    page: [
      `if [ "$SESS_MODE" = "resume" ] && [ "${onResume}" = "unresumable" ]; then`,
      '  echo "No conversation found with session ID: $SESS_ID"',
      "  exit 1",
      "fi",
      `if [ "$SESS_MODE" = "resume" ] && [ "${onResume}" = "rateLimit" ]; then`,
      `  cat <<'JSON'\n${rateLimitPayload}\nJSON`,
      "  exit 1",
      "fi",
      `if [ "$SESS_MODE" = "resume" ] && [ "${onResume}" = "fail" ]; then`,
      `  cat <<'JSON'\n${failPayload}\nJSON`,
      "  exit 2",
      "fi",
      `if [ "$SESS_MODE" = "new" ] && [ "${onFresh}" = "stall" ]; then sleep 30; fi`,
      WRITE_PAGE,
    ],
  });
}

/* ── split-planning shims ──────────────────────────────────────────────────
 * Sessions of a decomposed build: the map session (MAP_FILE), one area
 * session per mapped area (AREA_ID + PART_FILE), then the ordinary page
 * sessions. Each branches on the same directive lines the model reads.
 */

export type SplitArea = { id: string; paths: string[]; pages: string[]; sources?: string[] };

const planEntry = (path: string) => ({
  path,
  type: "concept",
  title: path.replace(/\.md$/, ""),
  brief: `Everything the bundle records about ${path}.`,
  sourcePaths: [],
  relatedPages: [],
});

export function claudeSplit(
  areas: SplitArea[],
  opts: {
    /** An area session that fails outright (exit 2). */
    failArea?: string;
    /** An area session killed by the usage limit. */
    rateLimitArea?: string;
    /** An area session that hangs past the step budget. */
    stallArea?: string;
    /** An area whose part is written but unusable (invalid JSON). */
    badPartArea?: string;
    /** An area whose part names an escaping page path. */
    escapingPartArea?: string;
    /** An area whose part lands but whose session then exits 2. */
    failAfterPartArea?: string;
    /** The map session writes its map, then hangs past the step budget. */
    stallMap?: boolean;
    /** An AREA_ID the shim did not enumerate still gets a part, so split
     *  `-part-N` areas the run derives are planned rather than skipped. */
    wildcard?: boolean;
    /** Exclusion proposals the map session writes beside its areas. */
    exclude?: { path: string; reason: string }[];
    page?: string[];
    /** Where every session's kind is appended, one line each. */
    log?: string;
    /** Where "<kind> <model>" is appended per session, one line each. */
    modelLog?: string;
  } = {},
): Promise<string> {
  const mapJson = JSON.stringify({
    areas: areas.map((a) => ({
      id: a.id,
      title: a.id,
      scope: `the ${a.id} area`,
      paths: a.paths,
    })),
    ...(opts.exclude === undefined || opts.exclude.length === 0 ? {} : { exclude: opts.exclude }),
  });
  const partBody = (a: (typeof areas)[number]): string => {
    if (opts.badPartArea === a.id) return `printf -- "not json\\n" > "$PART_FILE"`;
    if (opts.escapingPartArea === a.id)
      return `printf '%s' '${JSON.stringify({ pages: [planEntry("../escape.md")] })}' > "$PART_FILE"`;
    return `printf '%s' '${JSON.stringify({
      pages: a.pages.map((path) => ({ ...planEntry(path), sourcePaths: a.sources ?? [] })),
    })}' > "$PART_FILE"`;
  };
  const partCases = areas.map((a) => [`  ${a.id})`, `    ${partBody(a)}`, "    ;;"].join("\n"));
  const log = opts.log;
  const logLines =
    log === undefined
      ? []
      : [
          `if [ -n "$MAP_FILE" ]; then echo map >> '${log}'; fi`,
          `if [ -n "$AREA_ID" ]; then echo "area:$AREA_ID" >> '${log}'; fi`,
          `if [ -n "$PAGE_PATH" ]; then echo "page:$PAGE_PATH" >> '${log}'; fi`,
        ];
  const modelLog = opts.modelLog;
  const modelLogLines =
    modelLog === undefined
      ? []
      : [
          'MODEL=""',
          'EFFORT=""',
          '_prev=""',
          'for _a in "$@"; do',
          '  if [ "$_prev" = "--model" ]; then MODEL="$_a"; fi',
          '  if [ "$_prev" = "--effort" ]; then EFFORT="$_a"; fi',
          '  _prev="$_a"',
          "done",
          `if [ -n "$MAP_FILE" ]; then echo "map $MODEL $EFFORT" >> '${modelLog}'; fi`,
          `if [ -n "$AREA_ID" ]; then echo "area $MODEL $EFFORT" >> '${modelLog}'; fi`,
          `if [ -n "$PAGE_PATH" ]; then echo "page $MODEL $EFFORT" >> '${modelLog}'; fi`,
        ];
  return writeShim(
    "claude",
    [
      ...CLAUDE_PROBES,
      'PROMPT="$2"',
      'if [ -n "$ODW_ARGV_OUT" ]; then printf "%s\\n=====\\n" "$PROMPT" >> "$ODW_ARGV_OUT"; fi',
      `MAP_FILE=$(printf '%s\\n' "$PROMPT" | sed -n 's/^MAP_FILE: //p' | head -1)`,
      `AREA_ID=$(printf '%s\\n' "$PROMPT" | sed -n 's/^AREA_ID: //p' | head -1)`,
      `PART_FILE=$(printf '%s\\n' "$PROMPT" | sed -n 's/^PART_FILE: //p' | head -1)`,
      `PAGE_PATH=$(printf '%s\\n' "$PROMPT" | sed -n 's/^PAGE_PATH: //p' | head -1)`,
      "mkdir -p ./openwiki",
      ...modelLogLines,
      ...logLines,
      'if [ -n "$MAP_FILE" ]; then',
      `  printf '%s' '${mapJson}' > "$MAP_FILE"`,
      ...(opts.stallMap === true ? ["  sleep 30"] : []),
      `  cat <<'JSON'\n${CLAUDE_OK}\nJSON`,
      "  exit 0",
      "fi",
      'if [ -n "$AREA_ID" ]; then',
      ...(opts.failArea === undefined
        ? []
        : [
            `  if [ "$AREA_ID" = ${JSON.stringify(opts.failArea)} ]; then`,
            '    echo "area exploded" >&2',
            "    exit 2",
            "  fi",
          ]),
      ...(opts.failAfterPartArea === undefined
        ? []
        : areas
            .filter((a) => a.id === opts.failAfterPartArea)
            .flatMap((a) => [
              `  if [ "$AREA_ID" = ${JSON.stringify(a.id)} ]; then`,
              `    ${partBody(a)}`,
              '    echo "area exploded after writing" >&2',
              "    exit 2",
              "  fi",
            ])),
      ...(opts.rateLimitArea === undefined
        ? []
        : [
            `  if [ "$AREA_ID" = ${JSON.stringify(opts.rateLimitArea)} ]; then`,
            `    cat <<'JSON'\n${JSON.stringify({
              is_error: true,
              terminal_reason: "api_error",
              api_error_status: 429,
              result: "Usage limit reached. Limit resets at 2026-09-01T12:00:00Z",
            })}\nJSON`,
            "    exit 1",
            "  fi",
          ]),
      ...(opts.stallArea === undefined
        ? []
        : [
            `  if [ "$AREA_ID" = ${JSON.stringify(opts.stallArea)} ]; then`,
            "    sleep 30",
            "  fi",
          ]),
      '  case "$AREA_ID" in',
      ...partCases,
      ...(opts.wildcard === true
        ? [
            "  *)",
            '    P="$AREA_ID.md"',
            '    cat > "$PART_FILE" <<EOF',
            '{"pages":[{"path":"$P","type":"concept","title":"$P","brief":"the $AREA_ID area","sourcePaths":[],"relatedPages":[]}]}',
            "EOF",
            "    ;;",
          ]
        : []),
      "  esac",
      `  cat <<'JSON'\n${CLAUDE_OK}\nJSON`,
      "  exit 0",
      "fi",
      'if [ -n "$PAGE_PATH" ]; then',
      '  mkdir -p "$(dirname "./openwiki/$PAGE_PATH")"',
      ...(opts.page ?? [WRITE_PAGE]),
      "fi",
      `cat <<'JSON'\n${CLAUDE_OK}\nJSON`,
      "exit 0",
    ].join("\n"),
  );
}

export function claudeHang(): Promise<string> {
  return writeShim("claude", [...CLAUDE_PROBES, "sleep 1", "exit 0"].join("\n"));
}

/** Revises one page, leaves the rest byte-identical, refreshes
 *  `.last-update.json`. Records argv for the change-set assertion. */
export function claudeScopedUpdate(pageToRevise: string, newHead: string): Promise<string> {
  return claudeSessions({
    payload: JSON.stringify({
      is_error: false,
      terminal_reason: "completed",
      result: `Revised ${pageToRevise}.`,
    }),
    plan: [pageToRevise],
    // Appended, not overwritten — every session in the run writes here.
    first: ['if [ -n "$ODW_ARGV_OUT" ]; then printf "%s\\n" "$@" >> "$ODW_ARGV_OUT"; fi'],
    page: [WRITE_PAGE_IF_MISSING],
    both: [
      `printf "\\nRevised for the change set.\\n" >> "./openwiki/${pageToRevise}"`,
      "if [ -f ./openwiki/.last-update.json ]; then",
      `  sed -e 's/"gitHead": "[^"]*"/"gitHead": "${newHead}"/' -e 's/"command": "[^"]*"/"command": "update"/' ./openwiki/.last-update.json > ./openwiki/.last-update.json.tmp`,
      "  mv ./openwiki/.last-update.json.tmp ./openwiki/.last-update.json",
      "fi",
    ],
  });
}

/** Proves openwiki continues another producer's bundle: reads `gitHead`,
 *  and exits non-zero if the anchor is unreadable. */
export function openwikiContinues(): Promise<string> {
  return writeShim(
    "openwiki",
    [
      'if [ "$1" = "--help" ]; then echo "OpenWiki v0.3.4"; exit 0; fi',
      'ANCHOR=$(sed -n \'s/.*"gitHead": "\\([^"]*\\)".*/\\1/p\' ./openwiki/.last-update.json)',
      'if [ -z "$ANCHOR" ]; then echo "no anchor to continue from" >&2; exit 1; fi',
      'if [ -n "$ODW_ANCHOR_OUT" ]; then echo "$ANCHOR" > "$ODW_ANCHOR_OUT"; fi',
      'printf "\\nContinued by openwiki.\\n" >> ./openwiki/index.md',
      "exit 0",
    ].join("\n"),
  );
}

/** A first run acceptance rejects, then a repair retry that fixes it. The
 *  session kind is the state: only the repair sees neither directive. */
export function claudeFailsThenRepairs(goodBundle: string, counterFile: string): Promise<string> {
  return claudeSessions({
    payload: JSON.stringify({ is_error: false, terminal_reason: "completed", result: "done" }),
    plan: ["page.md"],
    // A stray file beside a proper page is what conformance catches.
    page: [WRITE_PAGE, 'printf -- "no frontmatter\\n" > ./openwiki/broken.md'],
    repair: [
      // Counts repairs, so a retry loop would be visible as more than one.
      `N=0; [ -f '${counterFile}' ] && N=$(cat '${counterFile}')`,
      `echo $((N + 1)) > '${counterFile}'`,
      "rm -rf ./openwiki",
      "mkdir -p ./openwiki",
      `cp -r '${goodBundle}/.' ./openwiki/`,
    ],
  });
}

/** Rewrites EVERY page — an over-broad update. */
export function claudeRewritesEverything(pageToPlan = "auth.md"): Promise<string> {
  return claudeSessions({
    payload: JSON.stringify({ is_error: false, terminal_reason: "completed", result: "done" }),
    plan: [pageToPlan],
    page: [WRITE_PAGE_IF_MISSING],
    // A glob loop, not `find -exec`: its escaped `;` does not survive being
    // assembled in a JS string.
    both: [
      "for f in ./openwiki/*.md ./openwiki/*/*.md; do",
      '  [ -f "$f" ] || continue',
      '  case "$(basename "$f")" in index.md|log.md|INSTRUCTIONS.md) continue;; esac',
      '  printf "\nrewritten\n" >> "$f"',
      "done",
    ],
  });
}

/** A `claude` shim that reassigns an existing page's `type`. */
export function claudeReassignsType(page: string, newType: string): Promise<string> {
  return claudeSessions({
    payload: JSON.stringify({ is_error: false, terminal_reason: "completed", result: "done" }),
    plan: [page],
    page: [WRITE_PAGE_IF_MISSING],
    both: [
      `sed -i.bak 's/^type: .*/type: ${newType}/' "./openwiki/${page}" && rm -f "./openwiki/${page}.bak"`,
    ],
  });
}
