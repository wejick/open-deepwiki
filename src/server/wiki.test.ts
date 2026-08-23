import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Client as DbClient } from "@libsql/client";
import { startServer, type ServeResult } from "./server.ts";
import {
  buildBreadcrumb,
  hasValidSession,
  parseCookies,
  renderRepoListBody,
  resolveWikiPath,
} from "./wiki.ts";
import { openDb } from "../index/db.ts";
import { indexRepo } from "../index/update.ts";
import { paths, type Config } from "../config/config.ts";
import type { RepoRecord, Registry } from "../repoManager/registry.ts";
import { stubFakeVecEmbeddings } from "../../test/helpers/fetchStub.ts";
import { bundleFixture, makeTmp, rmTmp } from "../../test/helpers/tmp.ts";
import { testConfig } from "../../test/helpers/config.ts";

// ---- pure helpers ----

describe("resolveWikiPath", () => {
  const repos = [{ repoId: "gitlab.com/team/repo" }, { repoId: "gitlab.com/team/repo-2" }];

  test("Repo root", () => {
    expect(resolveWikiPath("/wiki/gitlab.com/team/repo", repos)).toEqual({
      repoId: "gitlab.com/team/repo",
      rest: "",
    });
  });

  test("Leaf page", () => {
    expect(resolveWikiPath("/wiki/gitlab.com/team/repo/architecture/overview", repos)).toEqual({
      repoId: "gitlab.com/team/repo",
      rest: "architecture/overview",
    });
  });

  test("Longest match wins for a repoId that prefixes another", () => {
    expect(resolveWikiPath("/wiki/gitlab.com/team/repo-2/x", repos)).toEqual({
      repoId: "gitlab.com/team/repo-2",
      rest: "x",
    });
  });

  test("Unknown repo", () => {
    expect(resolveWikiPath("/wiki/unknown/repo/x", repos)).toBeNull();
  });

  test("Bare /wiki has no repo prefix", () => {
    expect(resolveWikiPath("/wiki", repos)).toBeNull();
  });
});

describe("buildBreadcrumb", () => {
  test("repo root: single, unlinked crumb", () => {
    expect(buildBreadcrumb("gitlab.com/team/repo", "", "gitlab.com/team/repo")).toEqual([
      { label: "gitlab.com/team/repo", href: null },
    ]);
  });

  test("leaf page: repoId and directories linked, current page not", () => {
    expect(
      buildBreadcrumb("gitlab.com/team/repo", "architecture/overview", "Architecture Overview"),
    ).toEqual([
      { label: "gitlab.com/team/repo", href: "/wiki/gitlab.com/team/repo" },
      { label: "architecture", href: "/wiki/gitlab.com/team/repo/architecture" },
      { label: "Architecture Overview", href: null },
    ]);
  });

  test("directory page: repoId linked, directory itself is the current crumb", () => {
    expect(buildBreadcrumb("gitlab.com/team/repo", "architecture", "architecture")).toEqual([
      { label: "gitlab.com/team/repo", href: "/wiki/gitlab.com/team/repo" },
      { label: "architecture", href: null },
    ]);
  });
});

function reqWithCookie(cookie: string | undefined): IncomingMessage {
  return { headers: { cookie } } as IncomingMessage;
}

describe("parseCookies / hasValidSession", () => {
  test("parses a cookie header into name/value pairs", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
  });

  test("empty header yields no cookies", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  test("valid session cookie accepted", () => {
    const cfg = { bearerToken: "secret" } as Config;
    expect(hasValidSession(reqWithCookie("odw_wiki_token=secret"), cfg)).toBe(true);
  });

  test("missing cookie rejected", () => {
    const cfg = { bearerToken: "secret" } as Config;
    expect(hasValidSession(reqWithCookie(undefined), cfg)).toBe(false);
  });

  test("no configured token always rejects (fail closed)", () => {
    const cfg = { bearerToken: undefined } as Config;
    expect(hasValidSession(reqWithCookie("odw_wiki_token=anything"), cfg)).toBe(false);
  });
});

describe("renderRepoListBody", () => {
  test("Repos listed with links", () => {
    const html = renderRepoListBody([{ repoId: "gitlab.com/team/repo" }]);
    expect(html).toContain('href="/wiki/gitlab.com/team/repo"');
  });

  test("No repos registered", () => {
    expect(renderRepoListBody([])).toContain("No repositories registered yet.");
  });
});

// ---- integration: real server + fixture bundle ----

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

const REPO_ID = "gitlab.corp/team/repo";

async function serveWiki(
  opts: { bindHost?: string; token?: string; empty?: boolean } = {},
): Promise<{ cfg: Config; served: ServeResult; checkout: string | null }> {
  const dir = await makeTmp();
  tmpDirs.push(dir);
  const port = await freePort();
  const cfg = testConfig(dir, {
    ODW_PORT: String(port),
    ODW_BIND_HOST: opts.bindHost ?? "127.0.0.1",
    ...(opts.token ? { ODW_BEARER_TOKEN: opts.token } : {}),
  });
  const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
  dbs.push(db);
  const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
  cleanups.push(stub.restore);

  let repos: RepoRecord[] = [];
  let checkoutDir: string | null = null;
  if (!opts.empty) {
    const checkout = join(dir, "repos", REPO_ID, "checkout");
    checkoutDir = checkout;
    await mkdir(checkout, { recursive: true });
    await cp(bundleFixture("openwiki-authored"), join(checkout, "openwiki"), { recursive: true });
    await indexRepo(db, cfg, REPO_ID, checkout);
    repos = [
      {
        repoId: REPO_ID,
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
      },
    ];
  }
  const registry: Registry = { repos };
  const served = await startServer({ cfg, db, registry });
  servers.push(served);
  return { cfg, served, checkout: checkoutDir };
}

describe("Repo directory listing", () => {
  test("Repos listed with links", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`href="/wiki/${REPO_ID}"`);
  });

  test("No repos registered", async () => {
    const { served } = await serveWiki({ empty: true });
    const res = await fetch(`${served.url}/wiki`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No repositories registered yet.");
  });
});

describe("Wiki page routing", () => {
  test("Repo root renders the top-level wiki listing", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki/${REPO_ID}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Directories");
    expect(body).toContain(`href="/wiki/${REPO_ID}/architecture"`);
    // root index.md carries okf_version frontmatter — it must be stripped, not rendered as text
    expect(body).not.toContain("okf_version");
  });

  test("Leaf page renders the concept", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki/${REPO_ID}/concepts/two-modes`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Code vs Personal Modes");
  });

  test("Directory page renders that directory's index", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki/${REPO_ID}/architecture`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`href="/wiki/${REPO_ID}/architecture/overview"`);
  });

  test("Unknown repo is 404", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki/no.such/repo`);
    expect(res.status).toBe(404);
  });

  test("Unknown page in a known repo is 404", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki/${REPO_ID}/nonexistent/page`);
    expect(res.status).toBe(404);
  });

  test("A concept indexed but missing on disk 404s instead of 500ing", async () => {
    // The index can outlive the file it points to (e.g. an update in
    // progress). Deleting the file after indexing reproduces that gap.
    const { served, checkout } = await serveWiki();
    await rm(join(checkout!, "openwiki", "concepts", "two-modes.md"));
    const res = await fetch(`${served.url}/wiki/${REPO_ID}/concepts/two-modes`);
    expect(res.status).toBe(404);
  });
});

describe("Rendered page content", () => {
  test("code block highlighted and Mermaid rendered as a diagram", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki/${REPO_ID}/concepts/two-modes`);
    const body = await res.text();
    expect(body).toContain("shiki"); // the fenced `sh` block
    expect(body).toContain('<pre class="mermaid">'); // the mermaid fence
    expect(body).toContain("mermaid.esm.min.mjs"); // bootstrap only loads because a diagram is present
  });
});

describe("Mermaid asset serving", () => {
  test("serves the entry module", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki/assets/mermaid/mermaid.esm.min.mjs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("mermaid");
  });

  test("path traversal outside the mermaid dist directory is rejected", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki/assets/mermaid/../../../package.json`);
    expect(res.status).not.toBe(200);
  });

  test("unknown asset is 404", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki/assets/mermaid/does-not-exist.mjs`);
    expect(res.status).toBe(404);
  });
});

describe("Cross-page link resolution", () => {
  test("a relative link to an existing concept is rewritten", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki/${REPO_ID}/concepts/two-modes`);
    const body = await res.text();
    expect(body).toContain(`href="/wiki/${REPO_ID}/architecture/overview"`);
  });
});

describe("Breadcrumb navigation", () => {
  test("leaf page breadcrumb links intermediate directories, not the current page", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki/${REPO_ID}/concepts/two-modes`);
    const body = await res.text();
    expect(body).toContain(`<a href="/wiki/${REPO_ID}">${REPO_ID}</a>`);
    expect(body).toContain(`<a href="/wiki/${REPO_ID}/concepts">concepts</a>`);
    expect(body).toContain('aria-current="page">Code vs Personal Modes<');
  });
});

describe("Wiki authentication", () => {
  test("Missing session and token rejected on a LAN bind", async () => {
    const { served } = await serveWiki({ bindHost: "0.0.0.0", token: "secret" });
    const res = await fetch(`${served.url}/wiki`);
    expect(res.status).toBe(401);
  });

  test("Token accepted via bootstrap link, then the session is reused", async () => {
    const { served } = await serveWiki({ bindHost: "0.0.0.0", token: "secret" });
    const bootstrap = await fetch(`${served.url}/wiki?token=secret`, { redirect: "manual" });
    expect(bootstrap.status).toBe(302);
    const cookie = bootstrap.headers.get("set-cookie");
    expect(cookie).toContain("odw_wiki_token=secret");

    const authed = await fetch(`${served.url}/wiki`, {
      headers: { cookie: cookie!.split(";")[0]! },
    });
    expect(authed.status).toBe(200);
  });

  test("Invalid token rejected", async () => {
    const { served } = await serveWiki({ bindHost: "0.0.0.0", token: "secret" });
    const res = await fetch(`${served.url}/wiki?token=wrong`, { redirect: "manual" });
    expect(res.status).toBe(401);
  });

  test("Deep link bootstrap sets session and redirects cleanly", async () => {
    const { served } = await serveWiki({ bindHost: "0.0.0.0", token: "secret" });
    const bootstrap = await fetch(`${served.url}/wiki/myrepo/index?token=secret`, {
      redirect: "manual",
    });
    expect(bootstrap.status).toBe(302);
    expect(bootstrap.headers.get("location")).toBe("/wiki/myrepo/index");
    const cookie = bootstrap.headers.get("set-cookie");
    expect(cookie).toContain("odw_wiki_token=secret");
  });

  test("Deep link with invalid token rejected and no session established", async () => {
    const { served } = await serveWiki({ bindHost: "0.0.0.0", token: "secret" });
    const res = await fetch(`${served.url}/wiki/myrepo?token=wrong`, { redirect: "manual" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("Bootstrap link with any token redirects cleanly when no session is required", async () => {
    // A localhost bind (or no configured token) needs no session at all —
    // a stale or wrong `?token=` must not 401 when the bare /wiki URL would
    // have worked unauthenticated.
    const { served } = await serveWiki(); // default bindHost is localhost, no token configured
    const res = await fetch(`${served.url}/wiki?token=anything`, { redirect: "manual" });
    expect(res.status).toBe(302);
  });

  test("Localhost bind exempt from auth", async () => {
    const { served } = await serveWiki({ token: "secret" }); // default bindHost is localhost
    const res = await fetch(`${served.url}/wiki`);
    expect(res.status).toBe(200);
  });
});
