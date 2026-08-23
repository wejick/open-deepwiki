import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import type { Client as DbClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type ServeResult } from "./server.ts";
import { openDb, getChunk } from "../index/db.ts";
import { indexRepo } from "../index/update.ts";
import { stubFakeVecEmbeddings } from "../../test/helpers/fetchStub.ts";
import { bundleFixture, makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";
import { paths, type Config } from "../config/config.ts";
import type { RepoRecord, Registry } from "../repoManager/registry.ts";
let tmpDirs: string[] = [];
let cleanups: (() => void)[] = [];
let dbs: DbClient[] = [];
let servers: ServeResult[] = [];

afterEach(async () => {
  for (const c of cleanups) c();
  cleanups = [];
  for (const s of servers) {
    try {
      await s.stop();
    } catch {
      // already stopped
    }
  }
  servers = [];
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  dbs = [];
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function connectMCP(mcpUrl: string, token?: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = token
    ? new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      })
    : new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  return client;
}

/** Index a fixture repo and serve it over loopback HTTP. */
async function serveFixture(
  opts: { bindHost?: string; token?: string; repoId?: string; env?: Record<string, string> } = {},
): Promise<{
  cfg: Config;
  db: DbClient;
  registry: Registry;
  served: ServeResult;
}> {
  const dir = await makeTmp();
  tmpDirs.push(dir);
  const port = await freePort();
  const cfg = testConfig(dir, {
    ODW_PORT: String(port),
    ODW_BIND_HOST: opts.bindHost ?? "127.0.0.1",
    ...(opts.token ? { ODW_BEARER_TOKEN: opts.token } : {}),
    ...(opts.env && { ...opts.env }),
  });
  const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
  dbs.push(db);
  const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
  cleanups.push(stub.restore);

  const repoId = opts.repoId ?? "gitlab.corp/team/repo";
  const checkout = join(dir, "repos", repoId, "checkout");
  await mkdir(checkout, { recursive: true });
  await cp(bundleFixture("valid"), join(checkout, "openwiki"), { recursive: true });
  await indexRepo(db, cfg, repoId, checkout);

  const record: RepoRecord = {
    repoId,
    source: "git@gitlab.corp:team/repo.git",
    clonePath: checkout,
    addedAt: new Date().toISOString(),
    schedule: null,
    instructions: undefined,
    producer: undefined,
    options: {},
    lastRun: {
      startedAt: null,
      finishedAt: null,
      outcome: "success",
      durationMs: 100,
      tokens: null,
      error: null,
    },
    lastIndexedSha: "abc1234",
    lastSuccessAt: new Date().toISOString(),
  };
  const registry: Registry = { repos: [record] };
  const served = await startServer({ cfg, db, registry });
  servers.push(served);
  return { cfg, db, registry, served };
}

describe("MCP over HTTP transport with bearer-token auth", () => {
  test("Client connects", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).toSorted();
    expect(names).toEqual(
      [
        "ask_repo",
        "get_wiki_page",
        "list_related",
        "list_repos",
        "search_code",
        "server_status",
      ].toSorted(),
    );
    await client.close();
  });

  test("Tool descriptions document response format", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((t) => [t.name, t.description ?? ""]));
    for (const name of ["list_repos", "search_code", "ask_repo", "list_related", "server_status"]) {
      expect(byName.get(name)).toContain("TOON");
    }
    expect(byName.get("get_wiki_page")).toContain("verbatim");
    await client.close();
  });

  test("Unauthenticated request rejected on LAN bind", async () => {
    const { served } = await serveFixture({ bindHost: "0.0.0.0", token: "secret" });

    const unauthStatus = await fetch(`${served.url}/status`);
    expect(unauthStatus.status).toBe(401);

    const unauthMcp = await fetch(`${served.mcpUrl}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(unauthMcp.status).toBe(401);

    // With the token, the MCP handshake succeeds.
    const client = await connectMCP(served.mcpUrl, "secret");
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(6);
    await client.close();

    // /healthz stays untokened even on a LAN bind.
    const health = await fetch(`${served.url}/healthz`);
    expect(health.status).toBe(200);
  });

  // Pinned spike (add-dashboard D3): the stateless transport answers bare
  // JSON-RPC POSTs — the dashboard calls tools/list + tools/call directly
  // from the browser without an initialize handshake.
  test("Bare JSON-RPC POSTs succeed without initialize", async () => {
    const { served } = await serveFixture();
    const post = (body: unknown) =>
      fetch(served.mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
    const list = await post({ jsonrpc: "2.0", method: "tools/list", id: 1 });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { result: { tools: { name: string }[] } };
    expect(listBody.result.tools.map((t) => t.name)).toContain("ask_repo");

    const call = await post({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 2,
      params: { name: "list_repos", arguments: {} },
    });
    expect(call.status).toBe(200);
    const callBody = (await call.json()) as {
      result: { content: { type: string; text: string }[] };
    };
    expect(callBody.result.content[0]?.text).toContain("gitlab.corp/team/repo");
  });
});

describe("MCP tools", () => {
  test("List repos via tool", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({ name: "list_repos", arguments: {} });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    expect(text).toContain("gitlab.corp/team/repo");
    expect(text).toContain("abc1234");
    await client.close();
  });

  test("Search returns ranked results", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "search_code",
      arguments: { repoId: "gitlab.corp/team/repo", query: "bearer", limit: 5 },
    });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    expect(text).toContain("token-validation");
    expect(text).toContain("gitlab.corp/team/repo");
    await client.close();
  });

  test("Single compact payload", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "search_code",
      arguments: { repoId: "gitlab.corp/team/repo", query: "bearer", limit: 5 },
    });
    expect(res.isError).toBeUndefined();
    // The payload appears exactly once, as TOON text that strictly decodes
    // back to the payload value; no structuredContent duplicates it.
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    const parsed = decode(text, { strict: true }) as {
      repoId?: string;
      results: unknown[];
    };
    expect(parsed.repoId).toBe("gitlab.corp/team/repo");
    expect(parsed.results.length).toBeGreaterThan(0);
    expect((res as { structuredContent?: unknown }).structuredContent).toBeUndefined();
    await client.close();
  });

  test("Scores rounded to 3 decimals", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "search_code",
      arguments: { repoId: "gitlab.corp/team/repo", query: "bearer", limit: 5 },
    });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    expect(text).not.toMatch(/-?\d+\.\d{4,}/);
    await client.close();
  });

  test("Repo list renders tabular", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const port = await freePort();
    const cfg = testConfig(dir, { ODW_PORT: String(port) });
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const repos: RepoRecord[] = [];
    for (const repoId of ["repoA", "repoB"] as const) {
      const checkout = join(dir, "repos", repoId, "checkout");
      await mkdir(checkout, { recursive: true });
      await cp(bundleFixture("valid"), join(checkout, "openwiki"), { recursive: true });
      await indexRepo(db, cfg, repoId, checkout);
      repos.push({
        repoId,
        source: `git@gitlab.corp:team/${repoId}.git`,
        clonePath: checkout,
        addedAt: new Date().toISOString(),
        schedule: null,
        instructions: undefined,
        producer: undefined,
        options: {},
        lastRun: {
          startedAt: null,
          finishedAt: null,
          outcome: "success",
          durationMs: 1,
          tokens: null,
          error: null,
        },
        lastIndexedSha: "sha",
        lastSuccessAt: new Date().toISOString(),
      });
    }
    const registry: Registry = { repos };
    const served = await startServer({ cfg, db, registry });
    servers.push(served);

    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({ name: "list_repos", arguments: {} });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    // Joined conceptTerms keep the records tabular: one header, one row per repo.
    expect(text).toMatch(/^repos\[2\]\{/);
    const rows = (decode(text, { strict: true }) as { repos: unknown[] }).repos;
    expect(rows).toHaveLength(2);
    await client.close();
  });

  test("Below-threshold closest matches encoded as TOON", async () => {
    const { served } = await serveFixture({ env: { ODW_VECTOR_MIN_SIMILARITY: "0.99" } });
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "ask_repo",
      arguments: {
        repoId: "gitlab.corp/team/repo",
        question: "how does bearer token validation work?",
      },
    });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    expect(text).toContain("No relevant content found");
    expect(text).toContain("use with caution");
    const tail = text.slice(text.indexOf("\n\n") + 2);
    expect(Array.isArray(decode(tail, { strict: true }))).toBe(true);
    await client.close();
  });

  test("Scoped search hoists repo attribution", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "search_code",
      arguments: { repoId: "gitlab.corp/team/repo", query: "bearer", limit: 5 },
    });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    const parsed = decode(text, { strict: true }) as {
      repoId?: string;
      results: { repoId?: string }[];
    };
    expect(parsed.repoId).toBe("gitlab.corp/team/repo");
    expect(parsed.results.length).toBeGreaterThan(0);
    for (const r of parsed.results) expect(r.repoId).toBeUndefined();
    await client.close();
  });

  test("Scoped question hoists repo attribution", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "ask_repo",
      arguments: { repoId: "gitlab.corp/team/repo", question: "how does token refresh work?" },
    });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    const parsed = decode(text, { strict: true }) as {
      repoId?: string;
      results: { repoId?: string }[];
    };
    expect(parsed.repoId).toBe("gitlab.corp/team/repo");
    expect(parsed.results.length).toBeGreaterThan(0);
    for (const r of parsed.results) expect(r.repoId).toBeUndefined();
    await client.close();
  });

  test("Regex mode passthrough", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "search_code",
      arguments: { repoId: "gitlab.corp/team/repo", query: "refresh(T|_t)oken", mode: "regex" },
    });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    expect(text).toContain("token-refresh");
    await client.close();
  });

  test("Invalid regex falls back", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "search_code",
      arguments: { repoId: "gitlab.corp/team/repo", query: "unclosed(", mode: "regex" },
    });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    expect(text).toContain("fell back to fixed-string");
    await client.close();
  });

  test("Keywords drive lexical recall", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    // The question's words appear nowhere; the keyword does. Lexical recall
    // must be driven by exactly the keyword groups.
    const res = await client.callTool({
      name: "ask_repo",
      arguments: {
        repoId: "gitlab.corp/team/repo",
        question: "quantumflux zebras?",
        keywords: ["bearer"],
      },
    });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    expect(text).toContain("token-validation"); // contains "bearer"
    await client.close();
  });

  test("Unknown concept path", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "list_related",
      arguments: { repoId: "gitlab.corp/team/repo", path: "nonexistent" },
    });
    expect(res.isError).toBe(true);
    expect(String((res.content as { text?: string }[])[0]?.text ?? "")).toContain("not found");
    await client.close();
  });

  test("Unscoped question routed across repos", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const port = await freePort();
    const cfg = testConfig(dir, { ODW_PORT: String(port), ODW_TOP_K_REPOS: "5" });
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const repos: RepoRecord[] = [];
    for (const [repoId, bundle] of [
      ["repoA", "valid"],
      ["repoB", "valid2"],
    ] as const) {
      const checkout = join(dir, "repos", repoId, "checkout");
      await mkdir(checkout, { recursive: true });
      await cp(bundleFixture(bundle), join(checkout, "openwiki"), { recursive: true });
      await indexRepo(db, cfg, repoId, checkout);
      repos.push({
        repoId,
        source: `git@gitlab.corp:team/${repoId}.git`,
        clonePath: checkout,
        addedAt: new Date().toISOString(),
        schedule: null,
        instructions: undefined,
        producer: undefined,
        options: {},
        lastRun: {
          startedAt: null,
          finishedAt: null,
          outcome: "success",
          durationMs: 1,
          tokens: null,
          error: null,
        },
        lastIndexedSha: "sha",
        lastSuccessAt: new Date().toISOString(),
      });
    }
    const registry: Registry = { repos };
    const served = await startServer({ cfg, db, registry });
    servers.push(served);

    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "ask_repo",
      arguments: { question: "token authentication database" },
    });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    expect(text).toContain("repoA");
    expect(text).toContain("repoB");
    // Unscoped: every result carries its own repoId (no top-level hoisting).
    const parsed = decode(text, { strict: true }) as {
      repoId?: string;
      results: { repoId?: string }[];
    };
    expect(parsed.repoId).toBeUndefined();
    expect(parsed.results.length).toBeGreaterThan(0);
    for (const r of parsed.results) expect(typeof r.repoId).toBe("string");
    await client.close();
  });

  test("Search unknown repo", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "search_code",
      arguments: { repoId: "nope/nope", query: "bearer" },
    });
    expect(res.isError).toBe(true);
    expect(String((res.content as { text?: string }[])[0]?.text ?? "")).toContain("not registered");
    await client.close();
  });

  test("Fetch file wiki page", async () => {
    const { cfg, served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const servedPath = join(
      cfg.dataDir,
      "repos",
      "gitlab.corp/team/repo",
      "checkout",
      "openwiki",
      "token-validation.md",
    );
    const before = await readFile(servedPath, "utf8");
    const res = await client.callTool({
      name: "get_wiki_page",
      arguments: { repoId: "gitlab.corp/team/repo", path: "token-validation" },
    });
    expect(res.isError).toBeUndefined();
    // Identity header, blank line, then the bundle file byte-for-byte.
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    expect(text).toBe(`repoId: gitlab.corp/team/repo\npath: token-validation\n\n${before}`);
    // Serving time only: the on-disk artifact is untouched.
    expect(await readFile(servedPath, "utf8")).toBe(before);
    await client.close();
  });

  test("Wiki page missing", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "get_wiki_page",
      arguments: { repoId: "gitlab.corp/team/repo", path: "nonexistent" },
    });
    expect(res.isError).toBe(true);
    expect(String((res.content as { text?: string }[])[0]?.text ?? "")).toContain("not found");
    await client.close();
  });

  test("Backlinks and outgoing links returned", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "list_related",
      arguments: { repoId: "gitlab.corp/team/repo", path: "token-validation" },
    });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    expect(text).toContain("token-refresh");
    expect(text).toContain("guide");
    await client.close();
  });

  test("Question returns recall with page identifiers", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "ask_repo",
      arguments: {
        repoId: "gitlab.corp/team/repo",
        question: "how does token refresh work?",
        keywords: ["refresh"],
      },
    });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    expect(text).toContain("token-refresh");
    expect(text).toContain("snippet");
    // recall-only: identifiers + snippets, never a synthesized answer
    expect(text.length).toBeLessThan(5000);
    await client.close();
  });

  test("No relevant content", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({
      name: "ask_repo",
      arguments: { repoId: "gitlab.corp/team/repo", question: "quantumflux quasars and zebras?" },
    });
    expect(res.isError).toBeUndefined();
    expect(String((res.content as { text?: string }[])[0]?.text ?? "")).toContain(
      "No relevant content",
    );
    await client.close();
  });

  test("Health question via MCP", async () => {
    const { served } = await serveFixture();
    const client = await connectMCP(served.mcpUrl);
    const res = await client.callTool({ name: "server_status", arguments: {} });
    expect(res.isError).toBeUndefined();
    const text = String((res.content as { text?: string }[])[0]?.text ?? "");
    expect(text).toContain("scheduler");
    expect(text).toContain("gitlab.corp/team/repo");
    expect(text).toContain("green");
    expect(text).toContain("runState");
    await client.close();
  });
});

describe("Read-only index access", () => {
  test("Invalid registry returns 500/errors instead of hanging", async () => {
    const dir = await makeTmp();
    tmpDirs.push(dir);
    const port = await freePort();
    const cfg = testConfig(dir, { ODW_PORT: String(port) });
    await writeFile(join(dir, "registry.yaml"), "repos: [unclosed\n"); // hand-edit typo
    const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
    dbs.push(db);
    // No registry passed: the server loads from the (invalid) file.
    const served = await startServer({ cfg, db });
    servers.push(served);

    const health = await fetch(`${served.url}/healthz`);
    expect(health.status).toBe(500); // not a hang
    expect(JSON.stringify(await health.json())).toContain("not valid YAML");

    const client = await connectMCP(served.mcpUrl);
    const list = await client.callTool({ name: "list_repos", arguments: {} });
    expect(list.isError).toBe(true);
    expect(String((list.content as { text?: string }[])[0]?.text ?? "")).toContain(
      "not valid YAML",
    );
    await client.close();
  });

  test("Server survives missing index", async () => {
    const { cfg, db, served } = await serveFixture({ repoId: "repoA" });
    // Second registered repo was never indexed (no chunks in the DB).
    const other: RepoRecord = {
      repoId: "repoB",
      source: "git@gitlab.corp:team/other.git",
      clonePath: join(cfg.dataDir, "repos", "repoB", "checkout"),
      addedAt: new Date().toISOString(),
      schedule: null,
      instructions: undefined,
      producer: undefined,
      options: {},
      lastRun: {
        startedAt: null,
        finishedAt: null,
        outcome: null,
        durationMs: null,
        tokens: null,
        error: null,
      },
      lastIndexedSha: null,
      lastSuccessAt: null,
    };
    void other; // registry is a fixture snapshot; repoB simply has no rows

    expect(await getChunk(db, "repoB", "wiki", "overview")).toBeNull();

    const client = await connectMCP(served.mcpUrl);
    const missing = await client.callTool({
      name: "get_wiki_page",
      arguments: { repoId: "repoB", path: "overview" },
    });
    expect(missing.isError).toBe(true);

    // The server keeps serving indexed repos.
    const ok = await client.callTool({
      name: "get_wiki_page",
      arguments: { repoId: "repoA", path: "overview" },
    });
    expect(ok.isError).toBeUndefined();
    await client.close();
  });
});

describe("Dashboard page delivery", () => {
  test("Page and script served locally", async () => {
    const { served } = await serveFixture();

    const page = await fetch(`${served.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain('<script type="module" src="/dashboard.js">');

    const script = await fetch(`${served.url}/dashboard.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    const js = await script.text();
    expect(js).toContain("renderRepoRows");

    // Neither file references external scripts, styles, fonts, or images.
    for (const text of [html, js]) {
      expect(text).not.toMatch(/(?:src|href)\s*=\s*["']https?:/);
      expect(text).not.toMatch(/@import\s+url\(/);
      expect(text).not.toMatch(/url\(\s*["']?https?:/);
    }
  });

  test("Dashboard shell untokened on LAN bind", async () => {
    const { served } = await serveFixture({ bindHost: "0.0.0.0", token: "secret" });

    const page = await fetch(`${served.url}/`);
    expect(page.status).toBe(200); // shell: no token needed

    const status = await fetch(`${served.url}/status`);
    expect(status.status).toBe(401); // data: still tokened

    const admin = await fetch(`${served.url}/api/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "/x" }),
    });
    expect(admin.status).toBe(401); // admin: still tokened
  });
});
