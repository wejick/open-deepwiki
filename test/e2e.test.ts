import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { Client as DbClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";
import { openDb } from "../src/index/db.ts";
import { runPipeline, recordRun } from "../src/repoManager/pipeline.ts";
import { startServer, type ServeResult } from "../src/server/server.ts";
import { createGitRepo, commitFiles } from "./helpers/gitFixture.ts";
import { openwikiHappy, pathWith } from "./helpers/shim.ts";
import { stubFakeVecEmbeddings } from "./helpers/fetchStub.ts";
import { bundleFixture, makeTmp, rmTmp } from "./helpers/tmp.ts";
import { testConfig } from "./helpers/config.ts";
import { paths } from "../src/config/config.ts";
import type { RepoRecord, Registry } from "../src/repoManager/registry.ts";

/**
 * End-to-end smoke (7.1): composition only, no new fakes — openwiki shim ->
 * real clone + index -> real server on an ephemeral port -> real MCP client
 * queries all six tools over Streamable HTTP.
 */

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

test("End-to-end: add repo -> wiki + index -> MCP tools answer over HTTP", async () => {
  const dir = await makeTmp();
  tmpDirs.push(dir);
  const cfg = testConfig(dir);
  const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
  dbs.push(db);
  const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
  cleanups.push(stub.restore);

  // 1. Remote fixture repo with a real git history.
  const remote = await createGitRepo(join(dir, "remote"), {
    "src/auth.ts": "export function validateToken(t: string) { return t.length > 10; }\n",
    "README.md": "# Fixture Auth Repo\n",
  });
  await commitFiles(remote, {
    "src/refresh.ts": "export function refreshToken(t: string) { return t; }\n",
  });

  // 2. Full pipeline via the openwiki shim (real spawn path).
  const shimDir = await openwikiHappy(bundleFixture("valid"));
  const repoId = "local/remote";
  const record: RepoRecord = {
    repoId,
    source: remote,
    clonePath: paths.checkout(cfg, repoId),
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
  const result = await runPipeline(cfg, db, record, "init", {
    env: { PATH: pathWith(shimDir) },
  });
  recordRun(record, result);
  expect(result.ok).toBe(true);
  expect(result.wikiChunks).toBe(5); // INSTRUCTIONS.md is structural, not a concept
  expect(result.sourceChunks).toBeGreaterThanOrEqual(2);
  db.close();

  // 3. Real server on an ephemeral port (read-only DB).
  const port = await new Promise<number>((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
  const scfg = testConfig(dir, { ODW_PORT: String(port) });
  const registry: Registry = { repos: [record] };
  const served = await startServer({ cfg: scfg, registry });
  servers.push(served);

  // 4. Real MCP client queries all six tools.
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(served.mcpUrl));
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);

  const list = await client.callTool({ name: "list_repos", arguments: {} });
  expect(String((list.content as { text?: string }[])[0]?.text)).toContain(repoId);

  const search = await client.callTool({
    name: "search_code",
    arguments: { repoId, query: "validateToken", mode: "auto" },
  });
  expect(String((search.content as { text?: string }[])[0]?.text)).toContain("src/auth.ts");

  const page = await client.callTool({
    name: "get_wiki_page",
    arguments: { repoId, path: "token-validation" },
  });
  expect(String((page.content as { text?: string }[])[0]?.text)).toContain("bearer tokens");

  const related = await client.callTool({
    name: "list_related",
    arguments: { repoId, path: "token-validation" },
  });
  expect(String((related.content as { text?: string }[])[0]?.text)).toContain("token-refresh");

  const ask = await client.callTool({
    name: "ask_repo",
    arguments: { repoId, question: "how does token refresh work?", keywords: ["refresh"] },
  });
  expect(String((ask.content as { text?: string }[])[0]?.text)).toContain("token-refresh");

  const status = await client.callTool({ name: "server_status", arguments: {} });
  expect(String((status.content as { text?: string }[])[0]?.text)).toContain("green");

  await client.close();
});
