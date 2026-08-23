// Pins Intl/Date output to UTC so fmtTime's local-time formatting is
// deterministic in CI regardless of the host machine's time zone.
process.env.TZ = "UTC";

import { describe, expect, test } from "bun:test";
import { PRODUCER_IDS } from "../config/config.ts";
import {
  addBody,
  addResultText,
  authHeaders,
  collectArgs,
  fieldHtml,
  fieldsFromSchema,
  fmtDuration,
  fmtProgress,
  fmtTime,
  errorCell,
  parseExcludeGlobs,
  renderRepoRows,
  rpcBody,
  scheduleCell,
  scheduleResultText,
  summarizeAsk,
  testQuestion,
  wikiHref,
  type PlanProgress,
  type StatusRepo,
  type ToolField,
} from "./dashboard.js";

const htmlText = await Bun.file(new URL("./dashboard.html", import.meta.url)).text();
const jsText = await Bun.file(new URL("./dashboard.js", import.meta.url)).text();

function repo(overrides: Partial<StatusRepo> = {}): StatusRepo {
  return {
    repoId: "gitlab.corp/team/repo",
    health: "green",
    docs: { wiki: 42, source: 310 },
    lastIndexedSha: "a1b2c3d4e5",
    lastError: null,
    lastDurationMs: 245_000,
    tokens: 21_000,
    runStartedAt: "2026-08-25T02:00:00.000Z",
    runFinishedAt: "2026-08-25T02:04:05.000Z",
    conceptTerms: ["token-validation", "middleware"],
    schedule: null,
    ...overrides,
  };
}

describe("Dashboard module", () => {
  test("imports without a DOM", () => {
    // The import at the top of this file already ran the module — reaching
    // this assertion proves the wiring guard kept document access out.
    expect(typeof renderRepoRows).toBe("function");
  });
});

describe("Repo status table", () => {
  test("Rows render from status", () => {
    const html = renderRepoRows([
      repo(),
      repo({ repoId: "local/x", health: "red", lastError: "openwiki exited 1: boom" }),
    ]);
    expect(html).toContain("gitlab.corp/team/repo");
    expect(html).toContain("<td>42</td>"); // wiki doc count, own column
    expect(html).toContain("<td>310</td>"); // source doc count, own column
    expect(html).not.toContain("42/310"); // not a combined ratio cell
    expect(html).toContain("a1b2c3d"); // abbreviated sha
    expect(html).toContain("4m 5s"); // duration
    expect(html).toContain("21000 tok"); // token usage
    expect(html).toContain('class="red"');
    expect(html).toContain("openwiki exited 1: boom"); // last error shown
  });

  test("Running repo indicated", () => {
    const html = renderRepoRows([repo({ runFinishedAt: null, runState: "running" })]);
    expect(html).toContain("running…");
  });

  test("Interrupted repo not shown as running", () => {
    const html = renderRepoRows([repo({ runFinishedAt: null, runState: "interrupted" })]);
    expect(html).toContain("interrupted since");
    expect(html).not.toContain("running…");
  });

  test("Classification missing renders as today", () => {
    const html = renderRepoRows([repo({ runFinishedAt: null })]);
    expect(html).toContain("running…");
  });

  test("A one-line error is shown as-is; a long one collapses behind its headline", () => {
    expect(errorCell("openwiki exited 1")).toContain('<div class="err">openwiki exited 1</div>');
    expect(errorCell("openwiki exited 1")).not.toContain("<details");
    expect(errorCell(null)).toBe("");

    const long = ["run failed", "concepts/a.md: not produced (exit 2)", "b".repeat(400)].join("\n");
    const cell = errorCell(long);
    expect(cell).toContain("<details");
    expect(cell).toContain("<summary>run failed (2 more lines)</summary>");
    expect(cell).toContain("concepts/a.md: not produced (exit 2)");
    expect(cell).toContain("b".repeat(400));
  });

  test("A long single-line error is summarized but kept whole", () => {
    const line = `run failed: ${"x".repeat(500)}`;
    const cell = errorCell(line);
    expect(cell).toContain("<details");
    expect(cell).toContain("…</summary>");
    expect(cell).toContain("x".repeat(500));
  });

  test("Errors are escaped in both the summary and the detail", () => {
    const cell = errorCell(`<script>alert(1)</script>\n<img onerror=x>`);
    expect(cell).not.toContain("<script>");
    expect(cell).not.toContain("<img");
    expect(cell).toContain("&lt;script&gt;");
    expect(cell).toContain("&lt;img");
  });

  test("Rows escape HTML in repo data", () => {
    const html = renderRepoRows([repo({ lastError: "<script>alert(1)</script>" })]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("Repo with wiki links to its wiki", () => {
    const html = renderRepoRows([repo()]);
    expect(html).toContain('<a data-wiki href="/wiki/gitlab.corp/team/repo">');
    // A token present at render time rides the link for the one-hop bootstrap.
    const withToken = renderRepoRows([repo()], "secret");
    expect(withToken).toContain('/wiki/gitlab.corp/team/repo?token=secret"');
  });

  test("Repo without wiki renders plain text", () => {
    const html = renderRepoRows([repo({ docs: { wiki: 0, source: 310 } })]);
    expect(html).not.toContain("<a");
    expect(html).toContain("<td>gitlab.corp/team/repo</td>");
  });

  test("Token typed after render updates links", () => {
    // Rows rendered tokenless still gain the token when it is typed later:
    // the pure path re-renders with the new token, the wiring listens for it.
    const later = renderRepoRows([repo()], "typed-after");
    expect(later).toContain("token=typed-after");
    expect(jsText).toContain('tokenInput.addEventListener("change"');
    expect(jsText).toContain("renderRepoRows(currentRepos, token())");
  });

  test("Row actions and required elements exist", () => {
    const row = renderRepoRows([repo()]);
    for (const action of ["test", "update", "reinit", "instructions", "schedule", "remove"]) {
      expect(row).toContain(`data-action="${action}"`);
    }
    for (const id of [
      "token",
      "refresh",
      "repo-rows",
      "add-form",
      "add-source",
      "tool-select",
      "tool-form",
      "tool-call",
      "tool-result",
    ]) {
      expect(htmlText).toContain(`id="${id}"`);
    }
  });
});

describe("Resume action", () => {
  test("Build in progress renders the action", () => {
    const row = renderRepoRows([repo({ build: { pinnedSha: "a1b2c3d4e5f6", attempts: 3 } })]);
    expect(row).toContain('data-action="resume"');
  });

  test("Idle repo renders no resume action", () => {
    const row = renderRepoRows([repo(), repo({ build: null })]);
    expect(row).not.toContain('data-action="resume"');
  });

  test("Click queues a resume without blocking", () => {
    const block = jsText.slice(
      jsText.indexOf('action === "resume"'),
      jsText.indexOf('action === "remove"'),
    );
    expect(block).toContain("api(`/api/repos/${encodeURIComponent(repoId)}/resume`");
    expect(block).toContain('method: "POST"');
    expect(block).not.toContain("confirm("); // non-destructive: no prompt
    expect(block).toContain("resume queued");
  });

  test("Rejection surfaced", () => {
    const block = jsText.slice(
      jsText.indexOf('action === "resume"'),
      jsText.indexOf('action === "remove"'),
    );
    expect(block).toContain('class="err"');
    expect(block).toContain("body.error"); // 409 error shown verbatim
  });
});

describe("Schedule editing", () => {
  test("Row shows the effective schedule", () => {
    expect(scheduleCell("0 3 * * *")).toBe("0 3 * * *");
    expect(scheduleCell(null)).toBe("default");
    const html = renderRepoRows([repo({ schedule: "0 3 * * *" }), repo({ repoId: "local/x" })]);
    expect(html).toContain('<td class="sched">0 3 * * *</td>'); // override expression
    expect(html).toContain('<td class="sched">default</td>'); // default marker
    expect(htmlText).toContain("<th>schedule</th>");
  });

  test("Editor pre-filled from the server", () => {
    const block = jsText.slice(jsText.indexOf('action === "schedule"'));
    expect(block).toContain("api(`/api/repos/${encodeURIComponent(repoId)}/schedule`)");
    expect(block).toContain('value="${esc(body.schedule ?? "")}"'); // pre-filled input
  });

  test("Save issues only the schedule request", () => {
    const saveBlock = jsText.slice(jsText.indexOf('action === "save-schedule"'));
    expect(saveBlock).toContain('method: "PUT"');
    expect(saveBlock).toContain("JSON.stringify({ schedule: value })"); // empty input clears
    expect(saveBlock).not.toContain("/update");
    expect(scheduleResultText(true, { schedule: null })).toBe("saved — applies immediately");
  });

  test("Invalid expression error surfaced", () => {
    expect(scheduleResultText(false, { error: "invalid cron expression" })).toContain(
      "invalid cron expression",
    );
    const saveBlock = jsText.slice(jsText.indexOf('action === "save-schedule"'));
    expect(saveBlock).toContain('class="err"'); // error text rendered
  });
});

describe("Bearer token field", () => {
  test("Token attached and persisted", () => {
    expect(authHeaders("secret")).toEqual({ authorization: "Bearer secret" });
    expect(authHeaders("")).toEqual({});
    // wiring: read from + persist to localStorage, attached to every request
    expect(jsText).toContain('localStorage.getItem("odw-token")');
    expect(jsText).toContain("localStorage.setItem");
    expect(jsText).toContain("...authHeaders(token())");
  });
});

describe("Wiki link", () => {
  test("Positive wiki count yields the /wiki/<repoId> URL", () => {
    expect(wikiHref("gitlab.corp/team/repo", 42, "")).toBe("/wiki/gitlab.corp/team/repo");
    expect(wikiHref("gitlab.corp/team/repo", 42, "s ecret")).toBe(
      "/wiki/gitlab.corp/team/repo?token=s%20ecret", // token is a query value, encoded
    );
  });

  test("Zero wiki count yields null (plain text, no dead link)", () => {
    expect(wikiHref("gitlab.corp/team/repo", 0, "secret")).toBeNull();
    expect(wikiHref("gitlab.corp/team/repo", Number.NaN, "secret")).toBeNull();
  });
});

describe("Manual refresh only", () => {
  test("No automatic polling", () => {
    expect(jsText).not.toContain("setInterval");
    expect(jsText).not.toContain("setTimeout");
  });

  test("Refresh button reloads data", () => {
    expect(jsText).toContain('$("refresh").addEventListener("click"');
    expect(jsText).toContain('api("/status")');
  });
});

describe("Repo management actions", () => {
  test("Remove requires confirmation", () => {
    expect(jsText).toContain("confirm(");
    expect(jsText.indexOf("confirm(")).toBeLessThan(jsText.indexOf('method: "DELETE"'));
  });

  test("Reinit requires confirmation and never issues an update", () => {
    const block = jsText.slice(
      jsText.indexOf('action === "reinit"'),
      jsText.indexOf('action === "remove"'),
    );
    expect(block).toContain("confirm(");
    expect(block.indexOf("confirm(")).toBeLessThan(block.indexOf("/reinit`"));
    expect(block).toContain('method: "POST"');
    expect(block).not.toContain("/update");
    expect(jsText).toContain('data-action="reinit"'); // the row button exists
  });

  test("Add submits the source", () => {
    expect(jsText).toContain('api("/api/repos"');
    expect(jsText).toContain("JSON.stringify(addBody(source, producer, excludes))");
  });

  test("Per-repo exclude globs › Entered globs are submitted", () => {
    expect(parseExcludeGlobs("**/*.snap\n**/*.a\n")).toEqual(["**/*.snap", "**/*.a"]);
    expect(addBody("git@x:y.git", "claude", parseExcludeGlobs("**/*.snap\n**/*.a\n"))).toEqual({
      source: "git@x:y.git",
      producer: "claude",
      excludeGlobs: ["**/*.snap", "**/*.a"],
    });
    // The form wires the parsed textarea value into the request body.
    expect(jsText).toContain('parseExcludeGlobs($("add-excludes").value)');
  });

  test("Per-repo exclude globs › Blank excludes field submits no globs", () => {
    expect(parseExcludeGlobs("")).toEqual([]);
    expect(parseExcludeGlobs("  \n \n")).toEqual([]);
    expect(addBody("git@x:y.git", "claude", parseExcludeGlobs(""))).toEqual({
      source: "git@x:y.git",
      producer: "claude",
    });
    // Blank lines and surrounding whitespace in a non-empty field are dropped.
    expect(parseExcludeGlobs(" a/** \n\n b/**\n")).toEqual(["a/**", "b/**"]);
  });

  test("parseExcludeGlobs deduplicates preserving first occurrence", () => {
    expect(parseExcludeGlobs("ci/**\n**/*.a\nci/**")).toEqual(["ci/**", "**/*.a"]);
  });

  test("Selector offers exactly the supported producers, no default", () => {
    const options = htmlText.match(/<select id="add-producer"[^>]*>([\s\S]*?)<\/select>/)![1]!;
    const values = [...options.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual([...PRODUCER_IDS]); // no empty/default option
  });

  test("Selected producer always submitted explicitly", () => {
    expect(addBody("git@x:y.git", "claude")).toEqual({ source: "git@x:y.git", producer: "claude" });
    expect(addBody("git@x:y.git", "openwiki")).toEqual({
      source: "git@x:y.git",
      producer: "openwiki",
    });
  });

  test("Acceptance names the producer", () => {
    const text = addResultText(true, { repoId: "local/x", producer: "openwiki", status: "queued" });
    expect(text).toContain("local/x");
    expect(text).toContain("openwiki");
  });

  test("Save persists without running", () => {
    // the save-instructions handler PUTs instructions and never triggers a run
    const saveBlock = jsText.slice(jsText.indexOf('action === "save-instructions"'));
    expect(saveBlock).toContain('method: "PUT"');
    expect(saveBlock).not.toContain("/update");
    expect(jsText).toContain("applies on the next wiki run");
  });

  test("Repo ids are URL-encoded in action paths", () => {
    expect(jsText).toContain("encodeURIComponent(repoId)");
  });
});

describe("Retrieval smoke test", () => {
  test("Test reports retrieval outcome", () => {
    const summary = summarizeAsk(
      JSON.stringify({
        results: [
          { path: "token-validation", score: 0.61 },
          { path: "overview", score: 0.5 },
        ],
      }),
    );
    expect(summary).toEqual({
      hits: 2,
      top: { path: "token-validation", score: 0.61 },
      message: null,
    });
  });

  test("Verbatim no-content message passes through", () => {
    const summary = summarizeAsk("No relevant content found for this question in repo x.");
    expect(summary.message).toBe("No relevant content found for this question in repo x.");
  });

  test("Question uses first concept term with overview fallback", () => {
    expect(testQuestion(repo())).toBe("token-validation");
    expect(testQuestion(repo({ conceptTerms: [] }))).toBe("overview");
    expect(jsText).toContain('name: "ask_repo"');
  });
});

describe("MCP playground", () => {
  const askSchema = {
    type: "object",
    properties: {
      repoId: { type: "string", description: "scope to one repo" },
      question: { type: "string" },
      keywords: { type: "array", items: { type: "string" } },
      limit: { type: "number" },
      mode: { type: "string", enum: ["auto", "literal", "regex"] },
      flag: { type: "boolean" },
    },
    required: ["question"],
  };

  test("Form fields derive from inputSchema", () => {
    const fields = fieldsFromSchema(askSchema);
    const byName = new Map(fields.map((f) => [f.name, f]));
    expect(byName.get("question")).toMatchObject({ required: true, kind: "text" });
    expect(byName.get("limit")).toMatchObject({ required: false, kind: "number" });
    expect(byName.get("keywords")).toMatchObject({ kind: "array" });
    expect(byName.get("mode")).toMatchObject({
      kind: "enum",
      options: ["auto", "literal", "regex"],
    });
    expect(byName.get("flag")).toMatchObject({ kind: "boolean" });
  });

  test("Field HTML renders controls", () => {
    const fields = fieldsFromSchema(askSchema);
    const mode = fields.find((f) => f.name === "mode") as ToolField;
    expect(fieldHtml(mode)).toContain("<select");
    expect(fieldHtml(mode)).toContain("literal");
    const question = fields.find((f) => f.name === "question") as ToolField;
    expect(fieldHtml(question)).toContain('type="text"');
    expect(fieldHtml(question)).toContain("question *");
  });

  test("Call builds arguments with coercion", () => {
    const fields = fieldsFromSchema(askSchema);
    const args = collectArgs(fields, {
      question: "how does refresh work?",
      limit: "5",
      keywords: "token, middleware",
      mode: "literal",
      flag: "true",
      repoId: "",
    });
    expect(args).toEqual({
      question: "how does refresh work?",
      limit: 5,
      keywords: ["token", "middleware"],
      mode: "literal",
      flag: true,
    }); // empty optional omitted, number/array/boolean coerced
  });

  test("Missing required argument throws", () => {
    const fields = fieldsFromSchema(askSchema);
    expect(() => collectArgs(fields, { question: "  " })).toThrow(
      "missing required argument: question",
    );
  });

  test("JSON-RPC body shape", () => {
    const body = rpcBody("tools/call", { name: "ask_repo", arguments: {} });
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("tools/call");
    expect(typeof body.id).toBe("number");
    expect(body.params).toEqual({ name: "ask_repo", arguments: {} });
  });

  test("Tools listed from the server (no hardcoded tool list)", () => {
    expect(jsText).toContain('mcp("tools/list")');
    expect(jsText).toContain('mcp("tools/call"');
    // MCP transport requires accepting both JSON and SSE encodings
    expect(jsText).toContain('accept: "application/json, text/event-stream"');
    // the playground renders whatever tools/list returns — no tool names
    // hardcoded beyond the Test button's ask_repo
    expect(jsText).not.toContain("search_code");
    expect(jsText).not.toContain("get_wiki_page");
    expect(jsText).not.toContain("list_repos");
  });
});

describe("Formatting", () => {
  test("fmtDuration", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(245_000)).toBe("4m 5s");
  });

  test("fmtTime renders in the viewer's local time zone", () => {
    expect(fmtTime(null)).toBe("—");
    expect(fmtTime(undefined)).toBe("—");
    // TZ is pinned to UTC above, so this resolves the same way on any CI
    // host regardless of its default locale — expected value is computed
    // via Intl too (not a hardcoded, locale-specific literal), since a
    // real browser resolves its own local zone and locale the same way.
    const expected = new Intl.DateTimeFormat(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date("2026-08-25T02:04:05.000Z"));
    expect(fmtTime("2026-08-25T02:04:05.000Z")).toBe(expected);
  });
});

describe("Repo status table columns", () => {
  test("Document counts render as separate columns", () => {
    expect(htmlText).toContain("<th>wiki docs</th>");
    expect(htmlText).toContain("<th>source docs</th>");
    expect(htmlText).not.toContain("wiki/src");
  });
});

describe("Production progress column", () => {
  const NOW = Date.parse("2026-09-01T12:00:00Z");

  test("Progress renders for a building repo", () => {
    const progress: PlanProgress = {
      phase: "planning",
      split: true,
      done: 3,
      total: 8,
      lastUnitAt: "2026-09-01T11:56:00Z",
    };
    expect(fmtProgress(progress, NOW)).toBe("planning 3/8 · 4m ago");
    expect(
      fmtProgress({ phase: "pages", split: true, done: 12, total: 22, lastUnitAt: null }, NOW),
    ).toBe("pages 12/22");
  });

  test("Undecomposed planning renders below-threshold", () => {
    expect(
      fmtProgress({ phase: "planning", split: false, done: 0, total: 0, lastUnitAt: null }, NOW),
    ).toBe("below threshold");
  });

  test("Null progress renders as today — no text, no cell content", () => {
    expect(fmtProgress(null, NOW)).toBe("");
    const html = renderRepoRows([repo()]);
    expect(html).toContain('<td class="prog"></td>');
    expect(html).not.toContain("below threshold");
  });

  test("A building repo's row carries its progress", () => {
    const html = renderRepoRows([
      repo({
        progress: {
          phase: "planning",
          split: true,
          done: 3,
          total: 8,
          lastUnitAt: "2026-09-01T11:56:00Z",
        },
      }),
    ]);
    expect(html).toContain("planning 3/8");
    // Rendered against the viewer's clock, so only the shape is fixed.
    expect(html).toMatch(/planning 3\/8 · \d+[smh] ago/);
  });

  test("The column header exists and the helper stays DOM-free", () => {
    expect(htmlText).toContain("<th>progress</th>");
    // Pure: the same input renders the same text anywhere it runs.
    expect(
      fmtProgress({ phase: "pages", split: true, done: 1, total: 2, lastUnitAt: null }, 0),
    ).toBe("pages 1/2");
  });
});
