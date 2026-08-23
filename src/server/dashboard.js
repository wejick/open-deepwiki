/**
 * open-deepwiki dashboard — vanilla JS, no framework, no build step.
 *
 * Structure rule (spec: dashboard › Dashboard page delivery): every function
 * above the "wiring" section is a pure exported helper so bun:test can import
 * and execute them without a DOM. DOM access happens only inside the guarded
 * wiring block at the bottom, which browsers run on load and Bun skips.
 */

// ---- pure helpers ----

export function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

let nextRpcId = 1;
export function rpcBody(method, params) {
  return { jsonrpc: "2.0", id: nextRpcId++, method, ...(params !== undefined ? { params } : {}) };
}

export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 > 0 ? ` ${s % 60}s` : ""}`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Renders in the viewer's local time zone (Intl resolves it — no offset math). */
export function fmtTime(iso) {
  if (!iso) return "—";
  return timeFmt.format(new Date(iso));
}

/** Add-form excludes textarea → the API's excludeGlobs: trimmed non-empty
 *  lines, deduplicated in first-occurrence order. */
export function parseExcludeGlobs(text) {
  const globs = [];
  for (const line of String(text).split("\n")) {
    const glob = line.trim();
    if (glob !== "" && !globs.includes(glob)) globs.push(glob);
  }
  return globs;
}

/** Add-form request body: producer is a mandatory explicit choice, always
 *  sent; excludeGlobs is sent only when the operator entered any. */
export function addBody(source, producer, excludeGlobs = []) {
  return { source, producer, ...(excludeGlobs.length > 0 ? { excludeGlobs } : {}) };
}

/** Add-form outcome text: names the repoId and effective producer on success. */
export function addResultText(ok, body) {
  return ok
    ? `queued: ${body.repoId} · ${body.producer} — hit Refresh to watch`
    : `error: ${body.error}`;
}

/** Override expression for the row cell; null means the default applies. */
export function scheduleCell(schedule) {
  return schedule ?? "default";
}

/** Schedule-save outcome text: the edit governs the running scheduler now. */
export function scheduleResultText(ok, body) {
  return ok ? "saved — applies immediately" : `error: ${body.error}`;
}

/** Age of the last progress beat, as a compact "4m ago" — or null. */
function fmtAgo(iso, now) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** Progress cell text: `planning 3/8 · 4m ago`, `pages 12/22`, or
 *  `below threshold` for in-flight planning that is not decomposed. */
export function fmtProgress(progress, now = Date.now()) {
  if (!progress) return "";
  if (progress.phase === "planning" && !progress.split) return "below threshold";
  const label = `${progress.phase} ${progress.done}/${progress.total}`;
  const ago = progress.lastUnitAt ? fmtAgo(progress.lastUnitAt, now) : null;
  return ago ? `${label} · ${ago}` : label;
}

/** Question for the per-row Test button: first concept term, else "overview". */
export function testQuestion(repo) {
  const terms = repo?.conceptTerms;
  return Array.isArray(terms) && terms.length > 0 ? terms[0] : "overview";
}

const ERROR_SUMMARY_MAX = 100;

export function errorCell(text) {
  if (!text) return "";
  const full = String(text);
  const head = full.split("\n")[0] ?? "";
  if (full === head && head.length <= ERROR_SUMMARY_MAX) {
    return `<div class="err">${esc(head)}</div>`;
  }
  const rest = full.split("\n").length - 1;
  const summary =
    (head.length > ERROR_SUMMARY_MAX ? `${head.slice(0, ERROR_SUMMARY_MAX)}…` : head) +
    (rest > 0 ? ` (${rest} more line${rest === 1 ? "" : "s"})` : "");
  return (
    `<details class="err"><summary>${esc(summary)}</summary>` +
    `<pre class="err-detail">${esc(full)}</pre></details>`
  );
}

/**
 * Wiki URL for a repo row: `/wiki/<id>`, carrying the header token for the
 * one-hop cookie bootstrap when present. Null when the repo has no indexed
 * wiki pages — the row renders its name as plain text instead of a dead link.
 * The repoId goes in raw (slashes literal), matching `/wiki`'s own repo list
 * and the resolver's longest-prefix match; `esc` at the render site makes it
 * attribute-safe.
 */
export function wikiHref(repoId, wikiCount, token) {
  if (!Number.isFinite(wikiCount) || wikiCount <= 0) return null;
  const base = `/wiki/${repoId}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/** One <tr> per repo: health, counts, sha, last run, error + actions. */
export function renderRepoRows(repos, token = "") {
  return repos
    .map((r) => {
      const state =
        r.runState ?? (r.runStartedAt != null && r.runFinishedAt == null ? "running" : null);
      const sha = r.lastIndexedSha ? r.lastIndexedSha.slice(0, 7) : "—";
      const lastRun =
        state === "running"
          ? `running… since ${fmtTime(r.runStartedAt)}`
          : state === "interrupted"
            ? `interrupted since ${fmtTime(r.runStartedAt)}`
            : r.runStartedAt != null
              ? `${fmtTime(r.runFinishedAt ?? r.runStartedAt)} · ${fmtDuration(r.lastDurationMs)}${r.tokens != null ? ` · ${r.tokens} tok` : ""}`
              : "never";
      const resumeBtn = r.build ? `<button data-action="resume">Resume</button>` : "";
      const href = wikiHref(r.repoId, r.docs?.wiki ?? 0, token);
      const nameCell =
        href !== null ? `<a data-wiki href="${esc(href)}">${esc(r.repoId)}</a>` : esc(r.repoId);
      return (
        `<tr data-repo="${esc(r.repoId)}">` +
        `<td>${nameCell}</td>` +
        `<td class="${esc(r.health)}">${esc(r.health)}</td>` +
        `<td>${r.docs.wiki}</td>` +
        `<td>${r.docs.source}</td>` +
        `<td>${esc(sha)}</td>` +
        `<td>${esc(lastRun)}</td>` +
        `<td class="sched">${esc(scheduleCell(r.schedule))}</td>` +
        `<td class="prog">${esc(fmtProgress(r.progress))}</td>` +
        `<td>` +
        errorCell(r.lastError) +
        `<button data-action="test">Test</button>` +
        `<button data-action="update">Update</button>` +
        `<button data-action="reinit">Reinit</button>` +
        resumeBtn +
        `<button data-action="instructions">Instructions</button>` +
        `<button data-action="schedule">Schedule</button>` +
        `<button data-action="remove">Remove</button>` +
        `<div class="out" hidden></div>` +
        `</td></tr>`
      );
    })
    .join("\n");
}

/**
 * Summarize an ask_repo tool-response text: JSON payloads become
 * { hits, top }; plain messages ("No relevant content…") pass through
 * verbatim in `message`.
 */
export function summarizeAsk(text) {
  try {
    const payload = JSON.parse(text);
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const first = results[0];
    return {
      hits: results.length,
      top: first ? { path: String(first.path ?? "?"), score: first.score ?? null } : null,
      message: null,
    };
  } catch {
    return { hits: 0, top: null, message: String(text) };
  }
}

/** inputSchema (JSON Schema) → flat field descriptors for the tool form. */
export function fieldsFromSchema(schema) {
  const props = schema?.properties ?? {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(props).map(([name, p]) => {
    const prop = p ?? {};
    const kind = Array.isArray(prop.enum)
      ? "enum"
      : prop.type === "number" || prop.type === "integer"
        ? "number"
        : prop.type === "boolean"
          ? "boolean"
          : prop.type === "array"
            ? "array"
            : "text";
    return {
      name,
      required: required.has(name),
      kind,
      options: Array.isArray(prop.enum) ? prop.enum : null,
      description: typeof prop.description === "string" ? prop.description : "",
    };
  });
}

/** One labeled control per field descriptor. */
export function fieldHtml(f) {
  const title = f.description ? ` title="${esc(f.description)}"` : "";
  const star = f.required ? " *" : "";
  if (f.kind === "enum" || f.kind === "boolean") {
    const options = f.kind === "boolean" ? ["true", "false"] : (f.options ?? []);
    return (
      `<label>${esc(f.name)}${star} <select name="${esc(f.name)}"${title}>` +
      `<option value=""></option>` +
      options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("") +
      `</select></label>`
    );
  }
  if (f.kind === "number") {
    return `<label>${esc(f.name)}${star} <input name="${esc(f.name)}" type="number"${title}></label>`;
  }
  const placeholder = f.kind === "array" ? ' placeholder="comma, separated"' : "";
  return `<label>${esc(f.name)}${star} <input name="${esc(f.name)}" type="text"${title}${placeholder}></label>`;
}

/** Field descriptors + raw string values → tool arguments (throws on missing required). */
export function collectArgs(fields, values) {
  const args = {};
  for (const f of fields) {
    const raw = values[f.name];
    const empty = raw === undefined || raw === null || String(raw).trim() === "";
    if (empty) {
      if (f.required) throw new Error(`missing required argument: ${f.name}`);
      continue;
    }
    if (f.kind === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`not a number: ${f.name}`);
      args[f.name] = n;
    } else if (f.kind === "boolean") {
      args[f.name] = raw === true || raw === "true";
    } else if (f.kind === "array") {
      args[f.name] = String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    } else {
      args[f.name] = String(raw);
    }
  }
  return args;
}

// ---- wiring (browser only; Bun tests import the helpers above) ----

const $ = (id) => document.getElementById(id);

if (typeof document !== "undefined") {
  const tokenInput = $("token");
  tokenInput.value = localStorage.getItem("odw-token") ?? "";
  const token = () => tokenInput.value.trim();

  async function api(path, opts = {}) {
    return fetch(path, {
      ...opts,
      headers: { "content-type": "application/json", ...authHeaders(token()), ...opts.headers },
    });
  }

  async function mcp(method, params) {
    const res = await api("/mcp", {
      method: "POST",
      // the Streamable HTTP transport requires accepting both encodings
      headers: { accept: "application/json, text/event-stream" },
      body: JSON.stringify(rpcBody(method, params)),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message ?? "rpc error");
    return body.result;
  }

  let currentRepos = [];

  async function refresh() {
    const res = await api("/status");
    if (!res.ok) {
      $("summary").textContent =
        `status ${res.status}${res.status === 401 ? " — token required?" : ""}`;
      return;
    }
    const status = await res.json();
    currentRepos = status.repos ?? [];
    $("repo-rows").innerHTML = renderRepoRows(currentRepos, token());
    const agg = status.aggregates?.health ?? {};
    $("summary").textContent =
      `${status.repoCount} repos · green ${agg.green ?? 0} yellow ${agg.yellow ?? 0} red ${agg.red ?? 0}` +
      ` · queue ${status.scheduler?.pending ?? 0} pending / ${status.scheduler?.inFlight ?? 0} in flight`;
  }

  $("refresh").addEventListener("click", () => void refresh());

  // Persist the token, then re-render so wiki links pick it up without a
  // refresh click (rows rendered before the token was typed carry no ?token=).
  tokenInput.addEventListener("change", () => {
    localStorage.setItem("odw-token", tokenInput.value);
    $("repo-rows").innerHTML = renderRepoRows(currentRepos, token());
  });

  $("repo-rows").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    const tr = btn.closest("tr");
    const repoId = tr.dataset.repo;
    const out = tr.querySelector(".out");
    const show = (html) => {
      out.hidden = false;
      out.innerHTML = html;
    };
    void rowAction(btn.dataset.action, repoId, out, show);
  });

  async function rowAction(action, repoId, out, show) {
    try {
      if (action === "test") {
        show("testing…");
        const row = currentRepos.find((r) => r.repoId === repoId);
        const result = await mcp("tools/call", {
          name: "ask_repo",
          arguments: { repoId, question: testQuestion(row) },
        });
        const summary = summarizeAsk(result.content?.[0]?.text ?? "");
        show(
          summary.message !== null
            ? esc(summary.message)
            : `${summary.hits} hits${summary.top ? ` · top: ${esc(summary.top.path)} (${summary.top.score})` : ""}`,
        );
      } else if (action === "update") {
        show("updating…");
        const res = await api(`/api/repos/${encodeURIComponent(repoId)}/update`, {
          method: "POST",
        });
        const body = await res.json();
        show(
          res.ok ? `queued — hit Refresh to watch` : `<span class="err">${esc(body.error)}</span>`,
        );
      } else if (action === "reinit") {
        // Discards the current wiki — confirm before submitting, like Remove.
        if (
          !confirm(
            `Reinitialize ${repoId}? This discards the current wiki and rebuilds it from scratch.`,
          )
        )
          return;
        show("re-initializing…");
        const res = await api(`/api/repos/${encodeURIComponent(repoId)}/reinit`, {
          method: "POST",
        });
        const body = await res.json();
        show(
          res.ok ? `queued — hit Refresh to watch` : `<span class="err">${esc(body.error)}</span>`,
        );
      } else if (action === "resume") {
        // Continues a preserved build at its pinned commit — non-destructive,
        // so no confirmation: the published wiki stays live throughout.
        show("resuming…");
        const res = await api(`/api/repos/${encodeURIComponent(repoId)}/resume`, {
          method: "POST",
        });
        const body = await res.json();
        show(
          res.ok
            ? `resume queued — hit Refresh to watch`
            : `<span class="err">${esc(body.error)}</span>`,
        );
      } else if (action === "remove") {
        if (!confirm(`Remove ${repoId}? This deletes the clone and all index rows.`)) return;
        const res = await api(`/api/repos/${encodeURIComponent(repoId)}`, { method: "DELETE" });
        if (res.ok) await refresh();
        else {
          const body = await res.json();
          show(`<span class="err">${esc(body.error)}</span>`);
        }
      } else if (action === "instructions") {
        const res = await api(`/api/repos/${encodeURIComponent(repoId)}/instructions`);
        const body = await res.json();
        show(
          `<textarea rows="6">${esc(body.instructions ?? "")}</textarea>` +
            `<br><button data-action="save-instructions">Save</button> ` +
            `<span class="muted">applies on the next wiki run</span>`,
        );
      } else if (action === "save-instructions") {
        const text = out.querySelector("textarea").value;
        const res = await api(`/api/repos/${encodeURIComponent(repoId)}/instructions`, {
          method: "PUT",
          body: JSON.stringify({ instructions: text }),
        });
        const body = await res.json();
        show(
          res.ok
            ? `saved — applies on the next wiki run`
            : `<span class="err">${esc(body.error)}</span>`,
        );
      } else if (action === "schedule") {
        const res = await api(`/api/repos/${encodeURIComponent(repoId)}/schedule`);
        const body = await res.json();
        show(
          `<input type="text" value="${esc(body.schedule ?? "")}" placeholder="cron expression, e.g. 0 3 * * *">` +
            `<br><button data-action="save-schedule">Save</button> ` +
            `<span class="muted">empty clears the override — applies immediately</span>`,
        );
      } else if (action === "save-schedule") {
        const value = out.querySelector("input").value;
        const res = await api(`/api/repos/${encodeURIComponent(repoId)}/schedule`, {
          method: "PUT",
          body: JSON.stringify({ schedule: value }),
        });
        const body = await res.json();
        show(
          res.ok
            ? scheduleResultText(true, body)
            : `<span class="err">${esc(scheduleResultText(false, body))}</span>`,
        );
      }
    } catch (e) {
      show(`<span class="err">${esc(e.message ?? e)}</span>`);
    }
  }

  $("add-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void (async () => {
      const source = $("add-source").value.trim();
      const producer = $("add-producer").value;
      const excludes = parseExcludeGlobs($("add-excludes").value);
      $("add-result").textContent = "adding…";
      try {
        const res = await api("/api/repos", {
          method: "POST",
          body: JSON.stringify(addBody(source, producer, excludes)),
        });
        const body = await res.json();
        $("add-result").textContent = addResultText(res.ok, body);
        if (res.ok) {
          $("add-source").value = "";
          $("add-excludes").value = ""; // producer selection persists for the next add
        }
      } catch (e) {
        $("add-result").textContent = `error: ${e.message ?? e}`;
      }
    })();
  });

  let tools = [];

  function renderToolForm() {
    const tool = tools.find((t) => t.name === $("tool-select").value);
    const fields = fieldsFromSchema(tool?.inputSchema);
    $("tool-form").innerHTML = fields.map(fieldHtml).join("<br>");
  }

  async function loadTools() {
    try {
      const result = await mcp("tools/list");
      tools = result.tools ?? [];
      $("tool-select").innerHTML = tools
        .map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`)
        .join("");
      renderToolForm();
    } catch (e) {
      $("tool-result").textContent = `error listing tools: ${e.message ?? e}`;
    }
  }

  $("tool-select").addEventListener("change", renderToolForm);

  $("tool-call").addEventListener("click", () => {
    void (async () => {
      const tool = tools.find((t) => t.name === $("tool-select").value);
      if (!tool) return;
      try {
        const values = Object.fromEntries(new FormData($("tool-form")).entries());
        const args = collectArgs(fieldsFromSchema(tool.inputSchema), values);
        const result = await mcp("tools/call", { name: tool.name, arguments: args });
        $("tool-result").textContent = JSON.stringify(result, null, 2);
      } catch (e) {
        $("tool-result").textContent = `error: ${e.message ?? e}`;
      }
    })();
  });

  void refresh();
  void loadTools();
}
