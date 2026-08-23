import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { paths, type Config } from "../config/config.ts";

/**
 * Append-only structured event log (`<dataDir>/events.jsonl`): forensic
 * debugging trail for indexing/scheduler runs. Never gates runtime behavior.
 * JSONL lines: { ts, type, repoId, ...details }. Rotates (truncates to zero)
 * when the file exceeds the configured size (default 10MB).
 */

export type EventType =
  | "run_started"
  | "run_succeeded"
  | "run_failed"
  | "run_rate_limited"
  | "queue_enqueued"
  | "producer_progress";

export type Event = {
  ts: string;
  type: EventType;
  repoId: string;
  /** Run lifecycle events: the producer that ran. queue_enqueued has none. */
  producer?: string;
  durationMs?: number;
  /** For run_rate_limited: when the provider says the limit resets. */
  resetAt?: string;
  tokens?: number;
  error?: string;
  /** For producer_progress: planning/session mark starts, the rest completions. */
  stage?: "planning" | "session" | "map" | "area" | "plan" | "page";
  /** For producer_progress: area id, page path, unit counts. */
  note?: string;
};

export async function appendEvent(cfg: Config, event: Omit<Event, "ts">): Promise<void> {
  const file = paths.events(cfg);
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  await mkdir(dirname(file), { recursive: true });

  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    // first event — file does not exist yet
  }
  if (size > 0 && size >= cfg.eventLogMaxBytes) {
    await writeFile(file, line); // rotate: truncate, start fresh
  } else {
    await appendFile(file, line);
  }
}

/** Tail the event log with optional repo filter (CLI `logs`). */
export async function readEvents(
  cfg: Config,
  opts: { repoId?: string; maxLines?: number } = {},
): Promise<Event[]> {
  let text: string;
  try {
    text = await Bun.file(paths.events(cfg)).text();
  } catch {
    return [];
  }
  const events = text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      try {
        return JSON.parse(l) as Event;
      } catch {
        return null;
      }
    })
    .filter((e): e is Event => e !== null);
  const filtered = opts.repoId ? events.filter((e) => e.repoId === opts.repoId) : events;
  return opts.maxLines ? filtered.slice(-opts.maxLines) : filtered;
}
