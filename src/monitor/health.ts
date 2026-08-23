import type { Config } from "../config/config.ts";
import type { RepoRecord } from "../repoManager/registry.ts";

/**
 * Deterministic repo health classification, computed at read time from
 * registry state (never stored): red = last run failed; yellow =
 * now − last_success > 2× expected update interval; green otherwise.
 */

export type Health = "green" | "yellow" | "red";

/** Rough update-interval estimate from a cron override (or the nightly default). */
export function intervalMsOfSchedule(
  schedule: string | null,
  nightly: { hour: number; minute: number },
): number {
  if (!schedule) return 24 * 3600 * 1000;
  const [minute, hour] = schedule.trim().split(/\s+/);
  if (hour === "*") {
    if ((minute ?? "").startsWith("*/")) {
      const m = Number((minute ?? "60").slice(2));
      if (Number.isFinite(m) && m > 0) return m * 60 * 1000;
    }
    return 60 * 60 * 1000; // hourly-ish
  }
  void nightly;
  return 24 * 3600 * 1000; // daily-ish
}

export function classifyHealth(repo: RepoRecord, cfg: Config, now: number = Date.now()): Health {
  if (repo.lastRun.outcome === "failed") return "red";
  // A rate limit is "come back later", not a broken repo: yellow, never red,
  // or one exhausted limit would paint the whole fleet red and destroy the
  // health signal (design D8).
  if (repo.lastRun.outcome === "rate_limited") return "yellow";
  // Sub-floor grounding is a quality regression, not a failure — the bundle is
  // still serveable, so it warrants attention rather than alarm (design D6).
  const score = repo.lastRun.groundingScore;
  if (score !== undefined && cfg.grounding.min > 0 && score < cfg.grounding.min) return "yellow";
  const last = repo.lastSuccessAt ? Date.parse(repo.lastSuccessAt) : null;
  if (last === null) return "green"; // never ran — spec: "green otherwise"
  const interval = intervalMsOfSchedule(repo.schedule, cfg.nightlyTime);
  if (now - last > 2 * interval) return "yellow";
  return "green";
}
