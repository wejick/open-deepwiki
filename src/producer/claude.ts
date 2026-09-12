import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ClaudeEffort, Config } from "../config/config.ts";
import { ENOENT, type ProducerInput, type ProducerOutcome } from "./contract.ts";
import {
  OVERVIEW_PAGE,
  areaFileBudget,
  expectedAreaCount,
  type Area,
  type PlanPage,
} from "./claudePlan.ts";
import { NO_MATTER_CACHE, pageConformance } from "./verify.ts";

/**
 * The `claude` producer's session substrate: one `claude -p` child process —
 * its spawn flags, outcome classification, and failure description — plus the
 * prompt builders every session kind is launched with. The run lifecycle that
 * sequences these sessions lives in `claudeRun.ts`.
 *
 * Flags verified live against CLI 2.1.228 — see `test/spike/` and AGENTS.md
 * for the findings behind them. Three that are easy to undo by accident:
 *
 *  - The contract goes in via `--append-system-prompt-file`; `--plugin-dir`
 *    finds the plugin but fails to invoke the skill headlessly.
 *  - No config-dir isolation: `claude` reads credentials from the directory
 *    openwiki-style isolation would replace, so it yields "Not logged in".
 *  - `Bash` is denied as a hard requirement, not hardening — the producer runs
 *    untrusted third-party repositories.
 */

const skillFile = (name: string): string =>
  fileURLToPath(new URL(`./skill/skills/okf-wiki/${name}`, import.meta.url));

/** Tool allowlist: read the checkout, write the bundle, nothing else. */
export const ALLOWED_TOOLS = "Read,Grep,Glob,Write,Edit";
/** Init planning sessions plan from the structure handout, so enumeration is
 *  not in their toolset — the handout is the only enumeration channel. */
export const PLANNING_TOOLS = "Read,Grep,Write";
export const DENIED_TOOLS = "Bash";

export const SETTING_SOURCES = "user";

export async function probeCapabilities(
  env: Record<string, string>,
  cwd: string,
): Promise<{ settingSources: boolean; sessionFlags: boolean }> {
  try {
    const proc = Bun.spawn(["claude", "--help"], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const help = await new Response(proc.stdout).text();
    await proc.exited;
    return {
      settingSources: help.includes("--setting-sources"),
      // Both must be advertised: naming a session without the resume flag
      // (or the reverse) would strand identities in the sidecar.
      sessionFlags: help.includes("--session-id") && help.includes("--resume"),
    };
  } catch {
    return { settingSources: false, sessionFlags: false };
  }
}

/** Rate-limit signals. The real payload was never observed — no limit was hit —
 *  so this matches defensively. */
const RATE_LIMIT_TEXT = /rate.?limit|usage limit|quota exceeded|too many requests|limit reached/i;
const RESET_AT = /reset[^0-9]{0,20}(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i;

export type ClaudeResult = {
  is_error?: unknown;
  terminal_reason?: unknown;
  result?: unknown;
  api_error_status?: unknown;
};

/** Classify an `--output-format json` payload. Exported so tests can drive it
 *  without spawning. */
export function classifyResult(json: ClaudeResult | null): {
  outcome: ProducerOutcome;
  resetAt: string | null;
} {
  if (json === null) return { outcome: "failed", resetAt: null };

  const text = typeof json.result === "string" ? json.result : "";
  const reason = typeof json.terminal_reason === "string" ? json.terminal_reason : "";
  const status = json.api_error_status;
  const limited = (): { outcome: ProducerOutcome; resetAt: string | null } => ({
    outcome: "rate_limited",
    resetAt: RESET_AT.exec(text)?.[1] ?? null,
  });

  // A 429 is a fact, so it outranks everything.
  if (status === 429 || status === "429") return limited();
  // The only shape that even claims success — and it is checked BEFORE the text
  // heuristics, because `result` is the model's own summary of the work it did.
  // A wiki for a throttling library says "rate limiter" in that summary, and
  // matching on it turned every successful run of such a repo into a fake
  // usage limit: never indexed, `lastIndexedSha` frozen.
  if (reason === "completed" && json.is_error !== true) return { outcome: "ok", resetAt: null };
  // Did not complete. Now the wording guesses are allowed to classify why.
  if (RATE_LIMIT_TEXT.test(text) || RATE_LIMIT_TEXT.test(reason)) return limited();
  return { outcome: "failed", resetAt: null };
}

/** One step's model/effort pair, unset fields inheriting the run's. */
export function stepOverrides(
  cfg: Config,
  step: "map" | "plan" | "page",
): { model?: string; effort?: ClaudeEffort } {
  const model = {
    map: cfg.claude.mapModel,
    plan: cfg.claude.planModel,
    page: cfg.claude.pageModel,
  }[step];
  const effort = {
    map: cfg.claude.mapEffort,
    plan: cfg.claude.planEffort,
    page: cfg.claude.pageEffort,
  }[step];
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/** The contract every session shares: SKILL.md, frontmatter stripped. */
export async function authoringPrompt(): Promise<string> {
  return matter(await readFile(skillFile("SKILL.md"), "utf8"), NO_MATTER_CACHE).content.trim();
}

export type Phase = "planner" | "page" | "map";

/** One phase file's body: what this session's job is, without the contract. */
async function phaseSection(phase: Phase): Promise<string> {
  const file = phase === "planner" ? "PLANNER.md" : phase === "map" ? "MAP.md" : "PAGE.md";
  return matter(await readFile(skillFile(file), "utf8"), NO_MATTER_CACHE).content.trim();
}

/** Shared contract plus one phase file, mirroring openwiki's prompt split. */
export async function phasePrompt(phase: Phase): Promise<string> {
  return `${await authoringPrompt()}\n\n${await phaseSection(phase)}\n`;
}

/** `PLAN_FILE` is on its own line: where the session writes its answer. */
export function plannerDirectives(
  mode: "init" | "update",
  input: ProducerInput,
  planFile: string,
  opts: { handoutFile?: string | null } = {},
): string {
  const lines: string[] = [`PLAN_FILE: ${planFile}`, ""];
  if (mode === "update") {
    lines.push("Mode: update. A bundle exists and the code moved.");
    if (input.fromSha !== undefined) {
      lines.push(`The bundle was generated from commit ${input.fromSha}.`);
    }
    if (input.changedPaths !== undefined && input.changedPaths.length > 0) {
      lines.push(
        `Changed source paths (plan only the pages these affect): ${input.changedPaths.join(", ")}`,
      );
    }
    if (input.typeVocabulary !== undefined && input.typeVocabulary.length > 0) {
      lines.push(
        `Existing frontmatter \`type\` values — an existing page keeps its type: ${input.typeVocabulary.join(", ")}`,
      );
    }
  } else {
    lines.push("Mode: init. No bundle exists yet; the plan must cover the whole repository.");
    lines.push(
      "Size the plan near one page per hundred documentable files: a page documents a subject, not a tree node. Do not plan one page per screen, dialog, or directory leaf when those pages would share a subject — cover them as sections of the page that documents that subject.",
    );
  }
  if (typeof opts.handoutFile === "string") {
    lines.push(
      "",
      `The repository structure is at ${opts.handoutFile}: every documentable file, per-directory counts and sizes, its largest files named. It is authoritative for what exists — read files only to understand what a directory is, to ground a page's brief, or to trace a flow; never to re-enumerate the tree.`,
    );
  }
  return lines.join("\n");
}

/** `MAP_FILE` is on its own line: where the map session writes its answer. */
export function mapDirectives(mapFile: string, digestFile: string, totalFiles: number): string {
  const budget = areaFileBudget(totalFiles);
  const expected = expectedAreaCount(totalFiles);
  return [
    `MAP_FILE: ${mapFile}`,
    "",
    `Read the repository digest at ${digestFile} before naming areas — it is the full documentable file tree. Files it omits are non-documentable (media, lockfiles, string catalogs, generated trees, animation bundles): they need no area and you may not claim them.`,
    "",
    `Cover the ${totalFiles} documentable files the digest lists with about ${expected} areas (accepted ${Math.ceil(expected / 2)}–${expected * 2}), each owning at most ${budget} documentable files — the repo root's own files are exempt and may exceed it. Areas may overlap: a file may belong to several areas, and no file must fall in exactly one.`,
    "",
    'Write {"areas":[{"id":"kebab-case-id","title":"…","scope":"what belongs on its pages","paths":["src/dir/"]}]} — paths are repo-relative directories or files.',
  ].join("\n");
}

/** `AREA_ID`/`PART_FILE` on their own lines: the one area this session plans
 *  and where its fragment goes. Everything else is the map's cargo. */
export function areaDirectives(
  area: Area,
  partFile: string,
  others: Area[],
  plannedTitles: string[],
  structureFile: string | null = null,
): string {
  const lines: string[] = [`AREA_ID: ${area.id}`, `PART_FILE: ${partFile}`, ""];
  lines.push(`Title: ${area.title}`);
  if (area.scope !== "") lines.push("", "Scope:", area.scope);
  lines.push("", `Paths this area owns: ${area.paths.join(", ")}`);
  if (others.length > 0) {
    lines.push(
      "",
      "Other areas — plan no page for their paths:",
      ...others.map((o) => `- ${o.id} (${o.title}): ${o.paths.join(", ")}`),
    );
  }
  if (structureFile !== null) {
    lines.push(
      "",
      `Structure handout for the paths this area owns: ${structureFile} — every documentable file there, per-directory counts and sizes, its largest files named. It is authoritative for what exists: do not enumerate the tree; read files only to understand what a directory is or to ground a page's brief.`,
    );
  }
  if (plannedTitles.length > 0) {
    lines.push(
      "",
      "Titles the other areas have already planned — plan no page for these subjects:",
      ...plannedTitles.map((t) => `- ${t}`),
    );
  }
  lines.push(
    "",
    "Plan only pages specific to this area's own paths. Cross-cutting subjects — state management, constants or configuration, utilities or helpers, navigation or routing, analytics or logging, error handling — are planned once for the whole bundle by the area whose paths host that code; plan no page that merely mirrors one for this area's slice.",
    "",
    "Size this area's plan near one page per hundred documentable files the area owns: a page documents a subject, not a tree node. Do not plan one page per screen, dialog, or directory leaf when those pages would share a subject — cover them as sections of the page that documents that subject.",
    "",
    `Write {"pages":[…]} — the ordinary plan entries for THIS area only, to PART_FILE. No map, no PLAN_FILE: a later merge combines every area.`,
  );
  return lines.join("\n");
}

/** `PAGE_PATH` is on its own line: the single file this session may write.
 *  Everything else is the planner's cargo, passed through verbatim. */
export function pageDirectives(page: PlanPage, otherPages: string[], input: ProducerInput): string {
  const lines: string[] = [`PAGE_PATH: ${page.path}`, ""];
  if (page.title !== "") lines.push(`Title: ${page.title}`);
  if (page.type !== "") lines.push(`Frontmatter type: ${page.type}`);
  if (page.brief !== "") lines.push("", "Brief:", page.brief);
  if (page.sourcePaths.length > 0) {
    lines.push("", `Start from these source files: ${page.sourcePaths.join(", ")}`);
  }
  if (otherPages.length > 0) {
    const label =
      page.path === OVERVIEW_PAGE
        ? "The bundle's finished pages — route the reader to these and link only to these"
        : "Other pages in this bundle — link only to these";
    lines.push("", `${label}: ${otherPages.join(", ")}`);
  }
  if (input.typeVocabulary !== undefined && input.typeVocabulary.length > 0) {
    lines.push(
      "",
      `\`type\` values already in use — an existing page keeps its type: ${input.typeVocabulary.join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** One child session's outcome. Never throws: a spawn failure is a result. */
export type Session = {
  outcome: ProducerOutcome;
  resetAt: string | null;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Killed by an in-flight abort (a rate-limited peer) before completing. */
  aborted: boolean;
  spawnError: string | null;
};

/** A session that never got as far as running. */
function sessionFailure(spawnError: string | null, stderr = ""): Session {
  return {
    outcome: "failed",
    resetAt: null,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr,
    timedOut: false,
    aborted: false,
    spawnError,
  };
}

export function describeSession(s: Session): string {
  if (s.spawnError !== null) return s.spawnError;
  if (s.timedOut) return "session timed out";

  let json: ClaudeResult | null = null;
  try {
    json = JSON.parse(s.stdout) as ClaudeResult;
  } catch {
    json = null;
  }

  const facts: string[] = [];
  if (s.outcome === "rate_limited") facts.push("rate limited");
  if (s.exitCode !== null && s.exitCode !== 0) facts.push(`exit ${s.exitCode}`);
  if (s.signal !== null) facts.push(`signal ${s.signal}`);
  const reason = typeof json?.terminal_reason === "string" ? json.terminal_reason : "";
  if (reason !== "" && reason !== "completed") facts.push(reason);
  if (json === null) facts.push(s.stdout.trim() === "" ? "no output" : "unparseable output");

  const said =
    typeof json?.result === "string" && json.result.trim() !== "" ? json.result : s.stderr;
  const detail = said
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "");
  if (detail !== undefined) facts.push(detail.length > 160 ? `${detail.slice(0, 160)}…` : detail);

  return facts.length > 0 ? facts.join("; ") : "session failed without saying why";
}

/** A page session's identity, assigned by the producer and persisted before
 *  the child spawns: `new` names a fresh session (`--session-id`), `resume`
 *  continues a recorded one (`--resume`). Only passed when the CLI advertised
 *  both flags — an unknown option is a hard error. */
export type SessionIdentity = { mode: "new" | "resume"; id: string };

export async function runSession(
  cfg: Config,
  args: {
    systemPromptFile: string;
    prompt: string;
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    extraArgs: string[];
    /** Per-step overrides; absent = the run-wide values. */
    model?: string;
    effort?: ClaudeEffort;
    /** Per-session-kind tool policy; default = the full allowlist. */
    allowedTools?: string;
    /** Abort kills the child early (a rate-limited peer ending the run). */
    signal?: AbortSignal;
    /** The session's assigned identity; absent = unresumed legacy behavior. */
    identity?: SessionIdentity;
  },
): Promise<Session> {
  let proc;
  try {
    proc = Bun.spawn(
      [
        "claude",
        "-p",
        args.prompt,
        "--append-system-prompt-file",
        args.systemPromptFile,
        "--model",
        args.model ?? cfg.claude.model,
        "--effort",
        args.effort ?? cfg.claude.effort,
        "--output-format",
        "json",
        "--allowedTools",
        args.allowedTools ?? ALLOWED_TOOLS,
        "--disallowedTools",
        DENIED_TOOLS,
        ...(args.identity === undefined
          ? []
          : args.identity.mode === "new"
            ? ["--session-id", args.identity.id]
            : ["--resume", args.identity.id]),
        ...args.extraArgs,
      ],
      { cwd: args.cwd, env: args.env, stdout: "pipe", stderr: "pipe" },
    );
  } catch (err) {
    return sessionFailure(
      ENOENT.test(String(err)) ? "ENOENT: claude not found on PATH" : String(err),
      String(err),
    );
  }

  // Do not await the pipes: a killed child's grandchild may still hold them.
  let timedOut = false;
  let aborted = false;
  let settled: () => void;
  const done = new Promise<void>((r) => {
    settled = r;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
    settled();
  }, args.timeoutMs);
  // Same kill path as the timeout, but at the caller's request: a rate-limited
  // page ends the run, so its in-flight peers are cancelled, not just orphaned.
  const onAbort = () => {
    aborted = true;
    proc.kill("SIGKILL");
    settled();
  };
  if (args.signal?.aborted === true) onAbort();
  else args.signal?.addEventListener("abort", onAbort, { once: true });
  proc.exited.catch(() => {}).then(() => settled());
  await done;
  clearTimeout(timer);
  args.signal?.removeEventListener("abort", onAbort);

  if (timedOut) return { ...sessionFailure(null), signal: "SIGKILL", timedOut: true };
  if (aborted) return { ...sessionFailure(null), signal: "SIGKILL", aborted: true };

  const exitCode = proc.exitCode;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  let json: ClaudeResult | null = null;
  try {
    json = JSON.parse(stdout) as ClaudeResult;
  } catch {
    json = null;
  }

  const { outcome, resetAt } = classifyResult(json);
  return {
    // A non-zero exit overrides a payload that claims completion.
    outcome:
      outcome === "rate_limited" ? outcome : exitCode === 0 && outcome === "ok" ? "ok" : "failed",
    resetAt,
    exitCode,
    signal: proc.signalCode ?? null,
    stdout,
    stderr,
    timedOut: false,
    aborted: false,
    spawnError: null,
  };
}

export function whyNotProduced(session: Session, left: string | null): string {
  if (session.outcome !== "ok") return describeSession(session);
  if (left === null) return "session reported success but wrote no page";
  return `session reported success but the page does not conform: ${pageConformance(left)}`;
}

/** Presence and reported version, for diagnostics. Nothing is pinned, so this
 *  only reports. */
export async function checkClaude(
  opts: { env?: Record<string, string> } = {},
): Promise<{ installed: string | null; missing: boolean }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...opts.env,
  };
  try {
    const proc = Bun.spawn(["claude", "--version"], { env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const m = /(\d+\.\d+\.\d+)/.exec(out);
    return { installed: m?.[1] ?? null, missing: false };
  } catch (err) {
    if (ENOENT.test(String(err))) return { installed: null, missing: true };
    return { installed: null, missing: false };
  }
}
