import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import type { Client as DbClient } from "@libsql/client";
import { startServer, type ServeResult } from "./server.ts";
import {
  buildBreadcrumb,
  buildNavTree,
  hasValidSession,
  parseCookies,
  parseIndexOrder,
  renderRepoListBody,
  renderSidebar,
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

// ---- sidebar tree ----

const NAV_CONCEPTS = [
  { path: "overview", title: "Overview" },
  { path: "token-validation", title: "Token Validation" },
  { path: "architecture/overview", title: "Architecture Overview" },
];

const NAV_REPO = {
  repoId: "gitlab.corp/team/repo",
  source: "git@gitlab.corp:team/repo.git",
  lastIndexedSha: "abc1234",
  lastSuccessAt: "2026-09-12T10:00:00.000Z",
};

describe("parseIndexOrder", () => {
  test("links in document order with their labels", () => {
    const entries = parseIndexOrder(
      "# Files\n\n- [Overview](overview.md) - intro\n- [Architecture](architecture/)\n",
    );
    expect(entries).toEqual([
      { label: "Overview", target: "overview.md" },
      { label: "Architecture", target: "architecture/" },
    ]);
  });
});

describe("buildNavTree", () => {
  test("Tree nested and ordered by index.md", () => {
    const orders = new Map([
      [
        "",
        [
          { label: "Token Validation", target: "token-validation.md" },
          { label: "Architecture", target: "architecture/" },
        ],
      ],
      ["architecture", [{ label: "Overview", target: "overview.md" }]],
    ]);
    expect(buildNavTree(NAV_CONCEPTS, orders)).toEqual([
      { kind: "page", path: "token-validation", label: "Token Validation" },
      {
        kind: "dir",
        path: "architecture",
        label: "Architecture",
        children: [{ kind: "page", path: "architecture/overview", label: "Architecture Overview" }],
      },
      { kind: "page", path: "overview", label: "Overview" },
    ]);
  });

  test("Unlisted concept still listed", () => {
    const orders = new Map([["", [{ label: "Overview", target: "overview.md" }]]]);
    const tree = buildNavTree(NAV_CONCEPTS, orders);
    expect(tree.map((n) => n.path)).toEqual(["overview", "architecture", "token-validation"]);
  });

  test("missing index.md falls back to path order", () => {
    const tree = buildNavTree(NAV_CONCEPTS, new Map());
    expect(tree.map((n) => n.path)).toEqual(["architecture", "overview", "token-validation"]);
  });

  test("only direct children are ordered by their own directory's index", () => {
    const concepts = [
      { path: "guide", title: "Guide" },
      { path: "guides/a", title: "A" },
      { path: "guides/sub/x", title: "X" },
    ];
    const orders = new Map([
      [
        "guides",
        [
          { label: "Guide", target: "../guide.md" },
          { label: "Sub", target: "sub/" },
        ],
      ],
    ]);
    const tree = buildNavTree(concepts, orders);
    expect(tree.map((n) => n.path)).toEqual(["guide", "guides"]);
    const guides = tree[1];
    expect(guides?.kind === "dir" ? guides.children.map((n) => n.path) : []).toEqual([
      "guides/sub",
      "guides/a",
    ]);
  });
});

describe("renderSidebar", () => {
  const tree = buildNavTree(NAV_CONCEPTS, new Map());

  test("Current concept marked", () => {
    const html = renderSidebar(tree, "token-validation", NAV_REPO);
    expect(html).toContain(
      'aria-current="page" href="/wiki/gitlab.corp/team/repo/token-validation"',
    );
    expect(html).not.toContain('aria-current="page" href="/wiki/gitlab.corp/team/repo/overview"');
  });

  test("Current directory marked", () => {
    const html = renderSidebar(tree, "architecture", NAV_REPO);
    expect(html).toContain('aria-current="page" href="/wiki/gitlab.corp/team/repo/architecture"');
  });

  test("Repo root has no current entry", () => {
    expect(renderSidebar(tree, "", NAV_REPO)).not.toContain("aria-current");
  });

  test("Indexed revision linked", () => {
    const html = renderSidebar(tree, "", NAV_REPO);
    expect(html).toContain("Last indexed: 2026-09-12");
    expect(html).toContain('href="https://gitlab.corp/team/repo/-/commit/abc1234">abc1234</a>');
  });

  test("Revision without a web location stays text", () => {
    const html = renderSidebar(tree, "", { ...NAV_REPO, source: "/srv/code/repo" });
    expect(html).toContain("(abc1234)");
    expect(html).not.toContain("commit");
  });

  test("Never-indexed repo renders without revision information", () => {
    const html = renderSidebar(tree, "", { ...NAV_REPO, lastIndexedSha: null });
    expect(html).not.toContain("Last indexed:");
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
  opts: {
    bindHost?: string;
    token?: string;
    empty?: boolean;
    bundle?: string;
    source?: string;
    lastIndexedSha?: string | null;
    files?: Record<string, string>;
  } = {},
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
    await cp(bundleFixture(opts.bundle ?? "openwiki-authored"), join(checkout, "openwiki"), {
      recursive: true,
    });
    for (const [rel, content] of Object.entries(opts.files ?? {})) {
      const target = join(checkout, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await indexRepo(db, cfg, REPO_ID, checkout);
    repos = [
      {
        repoId: REPO_ID,
        source: opts.source ?? "git@gitlab.corp:team/repo.git",
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
        lastIndexedSha: opts.lastIndexedSha === undefined ? "abc1234" : opts.lastIndexedSha,
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
  test("Repo root", async () => {
    const { served } = await serveWiki();
    const res = await fetch(`${served.url}/wiki/${REPO_ID}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Directories");
    expect(body).toContain(`href="/wiki/${REPO_ID}/architecture"`);
    // root index.md carries okf_version frontmatter — it must be stripped, not rendered as text
    expect(body).not.toContain("okf_version");
  });

  test("Repo root renders overview", async () => {
    const { served } = await serveWiki({ bundle: "valid" });
    const res = await fetch(`${served.url}/wiki/${REPO_ID}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Overview of Fixture Repo");
    expect(body).toContain('class="outline"');
  });

  test("Root overview marked", async () => {
    const { served } = await serveWiki({ bundle: "valid" });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}`)).text();
    expect(sidebarOf(body)).toContain(`aria-current="page" href="/wiki/${REPO_ID}/overview"`);
  });

  test("Repo root with an overview missing on disk falls back to the listing", async () => {
    const { served, checkout } = await serveWiki({ bundle: "valid" });
    await rm(join(checkout!, "openwiki", "overview.md"));
    const res = await fetch(`${served.url}/wiki/${REPO_ID}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1 id="files">');
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

describe("Page sources rendered with forge links", () => {
  test("GitLab citation linked", async () => {
    const { served } = await serveWiki({ bundle: "sourced" });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(body).toContain(
      'href="https://gitlab.corp/team/repo/-/blob/abc1234/src/auth.ts#L10-20"',
    );
    expect(body).toContain("<code>src/auth.ts:10-20</code>");
  });

  test("GitHub citation linked", async () => {
    const { served } = await serveWiki({
      bundle: "sourced",
      source: "git@github.com:team/repo.git",
    });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(body).toContain('href="https://github.com/team/repo/blob/abc1234/src/auth.ts#L10-L20"');
  });

  test("File citation without a line range", async () => {
    const { served } = await serveWiki({ bundle: "sourced" });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(body).toContain('href="https://gitlab.corp/team/repo/-/blob/abc1234/README.md"');
    expect(body).not.toContain("README.md#");
  });

  test("Single-line citation", async () => {
    const { served } = await serveWiki({ bundle: "sourced" });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(body).toContain('href="https://gitlab.corp/team/repo/-/blob/abc1234/src/auth.ts#L8"');
  });

  test("Unlinkable repository degrades to text", async () => {
    const { served } = await serveWiki({ bundle: "sourced", source: "/srv/code/repo" });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(body).toContain("<code>src/auth.ts:10-20</code>");
    expect(body).not.toContain("https://");
  });

  test("Unindexed repository degrades to text", async () => {
    const { served } = await serveWiki({ bundle: "sourced", lastIndexedSha: null });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(body).toContain("<code>src/auth.ts:10-20</code>");
    expect(body).not.toContain("https://gitlab.corp");
  });

  test("Non-repo resources and pages without sources", async () => {
    const { served } = await serveWiki({ bundle: "sourced" });
    const cited = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(cited).not.toContain("example.com");
    const plain = await (await fetch(`${served.url}/wiki/${REPO_ID}/plain`)).text();
    expect(plain).not.toContain('class="sources"');
  });

  test("real bundle page sources link at the indexed revision", async () => {
    const { served } = await serveWiki();
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/concepts/two-modes`)).text();
    expect(body).toContain('href="https://gitlab.corp/team/repo/-/blob/abc1234/README.md"');
  });

  test("entry text and href are escaped", async () => {
    const { served } = await serveWiki({ bundle: "sourced" });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(body).toContain("<code>src/a&amp;b&lt;c&gt;.ts:1</code>");
    expect(body).toContain("src/a%26b%3Cc%3E.ts#L1");
  });
});

describe("Inline source citations linked", () => {
  const FILE = "export const x = 1;\n";

  test("inline mention links to the forge at the indexed revision", async () => {
    const { served } = await serveWiki({ bundle: "sourced", files: { "src/auth.ts": FILE } });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(body).toContain(
      '<a href="https://gitlab.corp/team/repo/-/blob/abc1234/src/auth.ts#L10-20"><code>src/auth.ts:10-20</code></a>',
    );
    expect(body).toContain(
      '<a href="https://gitlab.corp/team/repo/-/blob/abc1234/src/auth.ts#L5-7"><code>src/auth.ts#L5-L7</code></a>',
    );
  });

  test("GitHub mention uses the GitHub fragment form", async () => {
    const { served } = await serveWiki({
      bundle: "sourced",
      source: "git@github.com:team/repo.git",
      files: { "src/auth.ts": FILE },
    });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(body).toContain('href="https://github.com/team/repo/blob/abc1234/src/auth.ts#L10-L20"');
  });

  test("single-line mention", async () => {
    const { served } = await serveWiki({ bundle: "sourced", files: { "src/auth.ts": FILE } });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(body).toContain('href="https://gitlab.corp/team/repo/-/blob/abc1234/src/auth.ts#L8"');
  });

  test("missing file, fenced block, and identifier stay plain", async () => {
    const { served } = await serveWiki({ bundle: "sourced", files: { "src/auth.ts": FILE } });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(body).toContain("<code>src/missing.ts:1-2</code>");
    expect(body).not.toContain("src/missing.ts#L1-2");
    expect(body).not.toContain("src/auth.ts#L1-2"); // fenced block, not a citation
    expect(body).toContain("<code>session.execution.succeeded</code>");
  });

  test("local repo keeps inline mentions plain", async () => {
    const { served } = await serveWiki({
      bundle: "sourced",
      source: "/srv/code/repo",
      files: { "src/auth.ts": FILE },
    });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/cited`)).text();
    expect(body).toContain("<code>src/auth.ts:10-20</code>");
    expect(body).not.toContain("src/auth.ts:10-20</a>");
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

function sidebarOf(body: string): string {
  const start = body.indexOf('<nav class="sidebar"');
  const end = body.indexOf("</nav>", start);
  return start === -1 ? "" : body.slice(start, end);
}

describe("Wiki navigation sidebar", () => {
  test("Repo root has a sidebar", async () => {
    const { served } = await serveWiki();
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}`)).text();
    const sidebar = sidebarOf(body);
    expect(sidebar).toContain(`href="/wiki/${REPO_ID}/architecture"`);
    expect(sidebar).toContain(`href="/wiki/${REPO_ID}/concepts/two-modes"`);
  });

  test("Repo directory listing has no sidebar", async () => {
    const { served } = await serveWiki();
    const body = await (await fetch(`${served.url}/wiki`)).text();
    expect(body).not.toContain('class="sidebar"');
  });

  test("Tree nested and ordered by index.md", async () => {
    const { served } = await serveWiki();
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}`)).text();
    const sidebar = sidebarOf(body);
    const architecture = sidebar.indexOf(`/wiki/${REPO_ID}/architecture"`);
    const concepts = sidebar.indexOf(`/wiki/${REPO_ID}/concepts"`);
    expect(architecture).toBeGreaterThanOrEqual(0);
    expect(architecture).toBeLessThan(concepts);
    expect(sidebar.indexOf(`/wiki/${REPO_ID}/concepts/two-modes`)).toBeGreaterThan(concepts);
  });

  test("Unlisted concept still listed", async () => {
    const { served } = await serveWiki({
      files: { "openwiki/extra.md": "---\ntype: concept\ntitle: Extra Page\n---\n\nBody.\n" },
    });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}`)).text();
    expect(sidebarOf(body)).toContain(`>Extra Page</a>`);
  });

  test("Current concept marked", async () => {
    const { served } = await serveWiki();
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/concepts/two-modes`)).text();
    expect(sidebarOf(body)).toContain(
      `aria-current="page" href="/wiki/${REPO_ID}/concepts/two-modes"`,
    );
  });

  test("Current directory marked", async () => {
    const { served } = await serveWiki();
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/architecture`)).text();
    expect(sidebarOf(body)).toContain(`aria-current="page" href="/wiki/${REPO_ID}/architecture"`);
  });

  test("Indexed revision linked", async () => {
    const { served } = await serveWiki();
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}`)).text();
    const today = new Date().toISOString().slice(0, 10);
    expect(sidebarOf(body)).toContain(`Last indexed: ${today}`);
    expect(sidebarOf(body)).toContain(
      'href="https://gitlab.corp/team/repo/-/commit/abc1234">abc1234</a>',
    );
  });

  test("Revision without a web location", async () => {
    const { served } = await serveWiki({ source: "/srv/code/repo" });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}`)).text();
    expect(sidebarOf(body)).toContain("(abc1234)");
    expect(sidebarOf(body)).not.toContain("/-/commit/");
  });

  test("Never-indexed repo renders without revision information", async () => {
    const { served } = await serveWiki({ lastIndexedSha: null });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}`)).text();
    expect(sidebarOf(body)).not.toContain("Last indexed:");
  });
});

describe("On this page outline", () => {
  test("Outline links to anchored headings", async () => {
    const { served } = await serveWiki();
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/concepts/two-modes`)).text();
    expect(body).toContain('<h1 id="code-vs-personal-modes">');
    expect(body).toContain('href="#code-vs-personal-modes"');
  });

  test("Indented by heading level", async () => {
    const { served } = await serveWiki();
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/concepts/two-modes`)).text();
    expect(body).toContain('style="padding-left:0px"');
    expect(body).toContain('style="padding-left:12px"');
  });

  test("Page without headings", async () => {
    const { served } = await serveWiki({
      files: {
        "openwiki/no-headings.md": "---\ntype: concept\ntitle: No Headings\n---\n\nJust text.\n",
      },
    });
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/no-headings`)).text();
    expect(body).not.toContain('class="outline"');
  });
});

describe("Responsive wiki layout", () => {
  test("Rails rendered beside content", async () => {
    const { served } = await serveWiki();
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}/concepts/two-modes`)).text();
    expect(body).toContain('<nav class="sidebar"');
    expect(body).toContain('<main class="content">');
    expect(body).toContain('<aside class="outline"');
  });

  test("Narrow viewports hide the rails", async () => {
    const { served } = await serveWiki();
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}`)).text();
    expect(body).toContain("@media (max-width: 1200px)");
    expect(body).toContain(".outline { display: none; }");
    expect(body).toContain("@media (max-width: 900px)");
    expect(body).toContain(".sidebar { display: none; }");
  });

  test("No client script for the rails", async () => {
    const { served } = await serveWiki();
    const body = await (await fetch(`${served.url}/wiki/${REPO_ID}`)).text();
    expect(body).not.toContain("<script");
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
