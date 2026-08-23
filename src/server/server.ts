import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Client } from "@libsql/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "../config/config.ts";
import { paths } from "../config/config.ts";
import { openDb } from "../index/db.ts";
import { loadRegistry, type Registry } from "../repoManager/registry.ts";
import type { SchedulerState } from "../repoManager/scheduler.ts";
import { buildStatusSummary, type StatusSummary } from "../monitor/status.ts";
import { registerTools, type ToolDeps } from "./tools.ts";
import { handleAdminApi } from "./admin.ts";
import { handleWiki } from "./wiki.ts";

/**
 * MCP server over Streamable HTTP (default `http://localhost:7245/mcp`).
 * Stateless per-request transport; bearer-token middleware when bound beyond
 * localhost (401 otherwise); the shared index DB is opened read-only (WAL
 * readers never block the nightly writer). GET /healthz (no token) and
 * GET /status (token) share the HTTP server.
 */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export type ServeResult = {
  http: HttpServer;
  url: string;
  mcpUrl: string;
  stop: () => Promise<void>;
};

export async function startServer(opts: {
  cfg: Config;
  db?: Client | null;
  registry?: Registry | null;
  schedulerState?: SchedulerState | null;
  startedAt?: number;
  /** Writable DB handle enabling the admin write API (`/api/*`). */
  adminDb?: Client | null;
  /** Called by the admin API after a schedule save, so the running
   *  scheduler applies the edit without a restart (serve wires it). */
  applySchedule?: ((repoId: string) => Promise<void> | void) | undefined;
}): Promise<ServeResult> {
  const { cfg } = opts;
  const startedAt = opts.startedAt ?? Date.now();

  // Ensure the shared DB file + schema exist, then open read-only for serving.
  if (!opts.db) {
    await mkdir(paths.indexDb(cfg).split("/").slice(0, -1).join("/"), { recursive: true });
    if (!(await exists(paths.indexDb(cfg)))) {
      const bootstrap = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
      bootstrap.close();
    }
  }
  const db =
    opts.db ?? (await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim, readOnly: true }));

  const getRegistry = async (): Promise<Registry> => opts.registry ?? (await loadRegistry(cfg));
  const getCheckouts = async (): Promise<Map<string, string>> => {
    const registry = await getRegistry();
    const checkouts = new Map<string, string>();
    for (const repo of registry.repos) checkouts.set(repo.repoId, repo.clonePath);
    return checkouts;
  };

  const getStatus = async (): Promise<StatusSummary> =>
    buildStatusSummary(cfg, db, await getRegistry(), {
      scheduler: opts.schedulerState ?? null,
      startedAt,
    });

  // Stateless MCP: a fresh McpServer per request (Protocol allows one
  // transport per instance — SDK's own stateless example does the same).
  const deps: ToolDeps = { cfg, db, getRegistry, getCheckouts, getStatus };
  const buildMcpServer = (): McpServer => {
    const mcp = new McpServer({ name: "open-deepwiki", version: "0.1.0" });
    registerTools(mcp, deps);
    return mcp;
  };

  const requiresToken = !LOCAL_HOSTS.has(cfg.bindHost);

  // Dashboard shell — read once, served from memory. Untokened even on LAN
  // binds (it carries no data; every fetch it makes is tokened separately).
  const dashboardHtml = await Bun.file(new URL("./dashboard.html", import.meta.url)).text();
  const dashboardJs = await Bun.file(new URL("./dashboard.js", import.meta.url)).text();

  // Mermaid's published browser bundle (its entry + lazily-imported
  // per-diagram-type chunks) served as static assets under /wiki — no
  // bundler, no build step (design: add-wiki-viewer). Resolved through the
  // module graph, not as a path relative to this file: a git worktree has no
  // `node_modules` of its own and hoisting can move the package anywhere up
  // the tree.
  const mermaidDistDir = fileURLToPath(
    new URL("dist/", import.meta.resolve("mermaid/package.json")),
  );

  const http = createServer((req, res) => {
    void route(req, res);
  });
  const sockets = new Set<Socket>();
  http.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await routeInner(req, res);
    } catch (err) {
      // e.g. an invalid hand-edited registry.yaml must not hang endpoints.
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } else {
        res.end();
      }
    }
  }

  async function routeInner(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(dashboardHtml);
      return;
    }
    if (url === "/dashboard.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(dashboardJs);
      return;
    }
    if (url === "/mcp" || url.startsWith("/mcp?")) {
      if (requiresToken && !hasValidToken(req, cfg)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      await handleMcp(req, res, buildMcpServer);
      return;
    }
    if (url === "/healthz" || url.startsWith("/healthz?")) {
      const summary = await getStatus();
      sendJson(res, 200, {
        ok: true,
        uptimeSec: summary.uptimeSec,
        repoCount: summary.repoCount,
      });
      return;
    }
    if (url === "/status" || url.startsWith("/status?")) {
      if (requiresToken && !hasValidToken(req, cfg)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      sendJson(res, 200, await getStatus());
      return;
    }
    if (url === "/wiki" || url.startsWith("/wiki/") || url.startsWith("/wiki?")) {
      await handleWiki(req, res, { cfg, db, getRegistry, requiresToken, mermaidDistDir }, url);
      return;
    }
    if (url.startsWith("/api/")) {
      if (requiresToken && !hasValidToken(req, cfg)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (opts.adminDb) {
        await handleAdminApi(req, res, {
          cfg,
          db: opts.adminDb,
          ...(opts.applySchedule ? { applySchedule: opts.applySchedule } : {}),
        });
        return;
      }
      sendJson(res, 404, { error: "not found" });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }

  await new Promise<void>((resolve) => {
    http.listen(cfg.port, cfg.bindHost, resolve);
  });

  const hostForUrl = LOCAL_HOSTS.has(cfg.bindHost) ? "localhost" : cfg.bindHost;
  return {
    http,
    url: `http://${hostForUrl}:${cfg.port}`,
    mcpUrl: `http://${hostForUrl}:${cfg.port}/mcp`,
    stop: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        http.close((e) => (e ? reject(e) : resolve()));
      });
      for (const s of sockets) s.destroy(); // drop open SSE streams so close completes
      await closed;
      if (!opts.db) db.close();
    },
  };
}

function hasValidToken(req: IncomingMessage, cfg: Config): boolean {
  if (!cfg.bearerToken) return false;
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${cfg.bearerToken}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  buildMcpServer: () => McpServer,
): Promise<void> {
  let body: unknown;
  if (req.method === "POST") {
    const raw = await readBody(req);
    try {
      body = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
  }
  const mcp = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    // stateless: no sessionIdGenerator
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
  });
  await mcp.connect(transport as Parameters<McpServer["connect"]>[0]);
  await transport.handleRequest(req, res, body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
