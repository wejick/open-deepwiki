/**
 * Types for dashboard.js — the plain-JS module served to the browser and
 * imported by bun tests. Keep in sync with dashboard.js exports.
 */

export function esc(s: unknown): string;

export function authHeaders(token: string): { authorization?: string };

export function rpcBody(
  method: string,
  params?: unknown,
): { jsonrpc: "2.0"; id: number; method: string; params?: unknown };

export function fmtDuration(ms: number | null | undefined): string;

export function fmtTime(iso: string | null | undefined): string;

/** Per-repo production progress, as carried by /status. */
export type PlanProgress = {
  phase: "planning" | "pages";
  split: boolean;
  done: number;
  total: number;
  lastUnitAt: string | null;
} | null;

/** Progress cell text; "" for null, "below threshold" when undecomposed. */
export function fmtProgress(progress: PlanProgress, now?: number): string;

export function testQuestion(repo: { conceptTerms?: string[] | undefined } | undefined): string;

export function addBody(
  source: string,
  producer: string,
  excludeGlobs?: string[],
): { source: string; producer: string; excludeGlobs?: string[] };

/** Add-form excludes textarea → trimmed non-empty lines, deduplicated. */
export function parseExcludeGlobs(text: string): string[];

export type AddResultBody =
  | { repoId: string; producer: string; status: string }
  | { error: string };

export function addResultText(ok: boolean, body: AddResultBody): string;

/** Row cell for the repo's schedule: the override, or the default marker. */
export function scheduleCell(schedule: string | null | undefined): string;

export type ScheduleResultBody = { schedule: string | null } | { error: string };

export function scheduleResultText(ok: boolean, body: ScheduleResultBody): string;

export type StatusRepo = {
  repoId: string;
  health: string;
  docs: { wiki: number; source: number };
  lastIndexedSha: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  tokens: number | null;
  runStartedAt: string | null;
  runFinishedAt: string | null;
  /** Read-time run liveness from /status; absent in older payloads, where
   *  start/finish times still derive it. */
  runState?: "running" | "interrupted" | null;
  conceptTerms: string[];
  schedule: string | null;
  progress?: PlanProgress;
  /** A preserved build in progress: reports Resume. */
  build?: { pinnedSha: string; attempts: number } | null;
};

export function errorCell(text: string | null | undefined): string;

/**
 * Wiki URL for a repo row (token appended for the one-hop cookie bootstrap
 * when present); null when the repo has no indexed wiki pages, which renders
 * the name as plain text.
 */
export function wikiHref(repoId: string, wikiCount: number, token: string): string | null;

export function renderRepoRows(repos: StatusRepo[], token?: string): string;

export type AskSummary =
  | { hits: number; top: { path: string; score: number | null } | null; message: null }
  | { hits: 0; top: null; message: string };

export function summarizeAsk(text: string): AskSummary;

export type ToolField = {
  name: string;
  required: boolean;
  kind: "text" | "number" | "boolean" | "enum" | "array";
  options: string[] | null;
  description: string;
};

export function fieldsFromSchema(schema: unknown): ToolField[];

export function fieldHtml(f: ToolField): string;

export function collectArgs(
  fields: ToolField[],
  values: Record<string, unknown>,
): Record<string, unknown>;
