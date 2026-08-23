import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, type Config } from "../config/config.ts";
import { ENOENT, type ProducerInput, type ProducerRun, type RunOptions } from "./contract.ts";

/**
 * The `openwiki` producer: `runOpenwiki` spawns the third-party CLI one-shot
 * with cwd = checkout dir. This module owns everything openwiki needs — the
 * spawn, the version handshake, and the seeded HOME.
 *
 * External facts, verified against v0.3.3 source and the live 2.1 spike: the
 * version is parsed from the `--help` banner (there is no `--version` flag),
 * and the CLI hardcodes `~/.openwiki` with no config-dir env override, so
 * isolation works by spawning with `HOME=<dataDir>/openwiki-config`.
 * `seedOpenwikiConfig` pre-writes the three files its onboarding wizard gate
 * requires — `onboarding.json` with `completedAt`/`modeId: "code"`, a
 * non-empty `INSTRUCTIONS.md` (openwiki's wiki-goal prompt), and provider
 * credentials in `.env` — so the CLI never stops to interview the operator
 * mid-run. openwiki must be installed under Node: its native better-sqlite3
 * binding does not build under bun.
 *
 * The shared producer vocabulary (`ProducerRun`, `ProducerInput`,
 * `RunOptions`) lives in `contract.ts`, not here.
 */

export type OpenwikiVersion = {
  installed: string | null;
  pinned: string;
  mismatch: boolean;
  missing: boolean;
};

export type SeedFiles = {
  dir: string;
  onboarding: string;
  instructions: string;
  env: string;
};

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export function openwikiProviderEnv(cfg: Config): Record<string, string> {
  const base = cfg.llm.baseUrl.replace(/\/+$/, "");
  const onOpenRouter = base === OPENROUTER_BASE || base.includes("openrouter.ai");
  const apiKey = cfg.llm.apiKey ?? "";
  const env: Record<string, string> = {
    OPENWIKI_PROVIDER: onOpenRouter ? "openrouter" : "openai-compatible",
    OPENWIKI_MODEL_ID: cfg.llm.model ?? "",
    // Anonymous telemetry is noise for a self-hosted deployment.
    OPENWIKI_TELEMETRY_DISABLED: "1",
  };
  if (onOpenRouter) {
    env.OPENROUTER_API_KEY = apiKey;
  } else {
    env.OPENAI_COMPATIBLE_API_KEY = apiKey;
    env.OPENAI_COMPATIBLE_BASE_URL = base;
  }
  return env;
}

export async function seedOpenwikiConfig(cfg: Config): Promise<SeedFiles> {
  const dir = paths.openwikiHome(cfg);
  await mkdir(dir, { recursive: true });

  const onboarding = join(dir, "onboarding.json");
  const instructions = join(dir, "INSTRUCTIONS.md");
  const envFile = join(dir, ".env");

  await writeFile(
    onboarding,
    `${JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        modeId: "code",
        version: 1,
        sourceInstances: [],
        sources: {},
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    instructions,
    "# Open Deep Wiki\n\nThis wiki is generated and maintained by open-deepwiki.\n",
  );
  const providerEnv = openwikiProviderEnv(cfg);
  await writeFile(
    envFile,
    [
      "# seeded by open-deepwiki; consumed by the openwiki CLI",
      ...Object.entries(providerEnv).map(([k, v]) => `${k}=${v}`),
      "",
    ].join("\n"),
  );

  return { dir, onboarding, instructions, env: envFile };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

export async function runOpenwiki(
  cfg: Config,
  mode: "init" | "update",
  checkoutDir: string,
  opts: RunOptions = {},
  // openwiki self-diffs from `.last-update.json`; it needs none of this.
  _input: ProducerInput = {},
): Promise<ProducerRun> {
  if (!cfg.llm.model || !cfg.llm.apiKey) {
    return {
      ok: false,
      outcome: "failed",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 0,
      spawnError:
        "wiki generation requires ODW_LLM_MODEL and an API key (ODW_LLM_API_KEY or OPENROUTER_API_KEY) — set them in .env",
      resetAt: null,
    };
  }
  const timeoutMs = opts.timeoutMs ?? cfg.openwikiTimeoutSec * 1000;
  const started = Date.now();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...opts.env,
  };

  let proc;
  try {
    proc = Bun.spawn(["openwiki", mode === "init" ? "--init" : "--update"], {
      cwd: checkoutDir,
      env: { ...env, HOME: paths.openwikiConfig(cfg) },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      ok: false,
      outcome: "failed",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: String(err),
      timedOut: false,
      durationMs: Date.now() - started,
      spawnError: ENOENT.test(String(err)) ? "ENOENT: openwiki not found on PATH" : String(err),
      resetAt: null,
    };
  }

  // Do not await the pipes on timeout: a killed shell's grandchild may still
  // hold them open.
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
      ok: false,
      outcome: "failed",
      exitCode: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
      timedOut: true,
      durationMs: Date.now() - started,
      spawnError: null,
      resetAt: null,
    };
  }

  const exitCode = proc.exitCode;
  const signal = proc.signalCode ?? null;
  const stdout = await readAll(proc.stdout);
  const stderr = await readAll(proc.stderr);

  return {
    ok: exitCode === 0,
    outcome: exitCode === 0 ? "ok" : "failed",
    exitCode,
    signal,
    stdout,
    stderr,
    timedOut,
    durationMs: Date.now() - started,
    spawnError: null,
    resetAt: null,
  };
}

/** Compare the installed openwiki major version against the pinned expectation.
 *  The CLI has no `--version` flag; the version is parsed from the `--help`
 *  banner (`OpenWiki v0.3.3`, exit 0). */
export async function checkOpenwikiVersion(
  cfg: Config,
  opts: { env?: Record<string, string> } = {},
): Promise<OpenwikiVersion> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...opts.env,
  };
  let installed: string | null = null;
  let missing = false;
  try {
    const proc = Bun.spawn(["openwiki", "--help"], { env, stdout: "pipe", stderr: "pipe" });
    const out = await readAll(proc.stdout);
    const m = /OpenWiki\s+v?(\d+\.\d+\.\d+)/i.exec(out);
    installed = m ? (m[1] ?? null) : null;
  } catch (err) {
    if (ENOENT.test(String(err))) missing = true;
  }

  const pinnedMajor = majorOf(cfg.openwikiVersion);
  const installedMajor = installed ? majorOf(installed) : null;
  const mismatch =
    !missing && installedMajor !== null && pinnedMajor !== null && installedMajor !== pinnedMajor;

  return { installed, pinned: cfg.openwikiVersion, mismatch, missing };
}

function majorOf(version: string): number | null {
  const m = /^[^\d]*(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : null;
}
