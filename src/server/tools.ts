import { z } from "zod";
import { encode } from "@toon-format/toon";
import type { Client } from "@libsql/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config/config.ts";
import {
  getChunk,
  listEdges,
  listAllDocCounts,
  listChunkSummaries,
  listRepoSummaries,
} from "../index/db.ts";
import { hybridSearch, type SearchHit } from "../index/search.ts";
import type { StatusSummary } from "../monitor/status.ts";
import { effectiveExcludes, type Registry, type RepoRecord } from "../repoManager/registry.ts";
import { webSourceUrl } from "../repoManager/webLinks.ts";

/**
 * MCP tool handlers — recall-only: ranked identifiers, snippets, citations.
 * The server never synthesizes answers; the client LLM does (D8). Tool
 * descriptions are the prompting surface: they document keyword group
 * semantics and search modes so the client can choose deliberately.
 *
 * Response encoding: every payload is returned exactly once as TOON text
 * (no structuredContent — no tool declares an outputSchema, so a second copy
 * has no consumer). Scores are rounded to 3 decimals at serialization;
 * ranking/threshold logic keeps full precision internally. get_wiki_page is
 * the document exception: identity header + the bundle file verbatim, since
 * TOON has no block scalars and escaping a markdown body would defeat the
 * point of the text channel.
 */

export type ToolDeps = {
  cfg: Config;
  db: Client;
  getRegistry: () => Promise<Registry>;
  getCheckouts: () => Promise<Map<string, string>>;
  getStatus: () => Promise<StatusSummary>;
};

const ASK_KEYWORDS_HINT =
  "Optional 1-5 grep-friendly keyword entries; each entry is a single term or a short " +
  "multi-term group. Terms within one entry are ANDed (all must appear in a file for the " +
  "entry to count); entries are OR-combined; matching is order-insensitive and " +
  "case-insensitive. The question drives semantic (vector) recall, the keywords drive " +
  'lexical (ripgrep) recall. For exact phrases use search_code with mode "literal".';

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Per-repo effective excludes for search: repos with registry globs get the
 * merged list; the rest ride the global config alone (represented by their
 * absence from the map, so the common fleet stays a single rg invocation).
 */
function repoExcludesFor(cfg: Config, registry: Registry): Map<string, string[]> | undefined {
  const map = new Map<string, string[]>();
  for (const repo of registry.repos) {
    if (repo.excludeGlobs?.length) {
      map.set(repo.repoId, effectiveExcludes(cfg, repo));
    }
  }
  return map.size > 0 ? map : undefined;
}

/** repoId -> the fields a forge permalink needs (source + indexed revision). */
function repoWebOf(registry: Registry): Map<string, Pick<RepoRecord, "source" | "lastIndexedSha">> {
  return new Map(
    registry.repos.map((r) => [r.repoId, { source: r.source, lastIndexedSha: r.lastIndexedSha }]),
  );
}

/**
 * Serialize search hits for the wire: round scores, attach a forge permalink
 * for source-kind results when the repo's source and indexed revision yield
 * one, and when the query was scoped to one repo, hoist attribution to the
 * payload's top-level repoId instead of repeating it per result.
 */
function serializeHits(
  results: SearchHit[],
  scoped: boolean,
  repos: Map<string, Pick<RepoRecord, "source" | "lastIndexedSha">>,
) {
  return results.map((r) => {
    const repo = repos.get(r.repoId);
    return {
      ...(scoped ? {} : { repoId: r.repoId }),
      path: r.path,
      kind: r.kind,
      title: r.title,
      description: r.description,
      snippet: r.snippet,
      score: round3(r.score),
      vectorSim: r.vectorSim === null ? null : round3(r.vectorSim),
      url:
        r.kind === "source" && repo
          ? webSourceUrl(repo.source, repo.lastIndexedSha, r.path, r.lineRanges[0] ?? null)
          : null,
      lineRanges: r.lineRanges,
    };
  });
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_repos",
    {
      description:
        "List all registered repositories with repoId, source, last indexed sha, document counts by kind (wiki concepts vs raw source files), link health, and auto-derived concept terms. " +
        "Response is TOON text (token-oriented object notation: key/value lines; arrays declare [N] lengths and tabular arrays declare {fields} headers).",
      inputSchema: {},
    },
    async () => {
      try {
        const registry = await deps.getRegistry();
        const counts = await listAllDocCounts(deps.db);
        const summaries = await listRepoSummaries(deps.db);
        const rows = registry.repos.map((repo) => {
          const c = counts.get(repo.repoId);
          const m = summaries.get(repo.repoId);
          return {
            repoId: repo.repoId,
            source: repo.source,
            lastIndexedSha: repo.lastIndexedSha,
            lastSuccessAt: repo.lastSuccessAt,
            docs: c ?? { wiki: 0, source: 0 },
            linkHealth: m
              ? { resolved: m.linkResolved, total: m.linkTotal }
              : { resolved: 0, total: 0 },
            // Space-joined so the array stays tabular at fleet scale; a
            // string cell reads identically to a term list for recall.
            conceptTerms: (m?.conceptTerms ?? []).join(" "),
          };
        });
        return ok(encode({ repos: rows }));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "search_code",
    {
      description:
        "Search a repository's code and wiki by combining ripgrep lexical matches with vector similarity, returning ranked, deduplicated results (kind, path, snippet, score, repo attribution). " +
        'Modes: "auto" (default — expands identifiers to camelCase/snake_case/kebab-case variants in one pass), ' +
        '"literal" (fixed-string matching of the exact query), "regex" (query is passed to ripgrep as a pattern; on compile error it retries as a fixed string and notes the fallback). ' +
        "Omit repoId to search across all repos (routed via repo centroids to the top-k most relevant repos; every result carries its repoId). " +
        "Response is TOON text (token-oriented object notation: key/value lines; arrays declare [N] lengths and tabular arrays declare {fields} headers).",
      inputSchema: {
        repoId: z
          .string()
          .optional()
          .describe("Scope to one repository; omit for cross-repo search"),
        query: z.string().describe("Search query"),
        mode: z
          .enum(["auto", "literal", "regex"])
          .optional()
          .describe("Matching mode (default auto)"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
      },
    },
    async (args) => {
      const query = args.query ?? "";
      if (query.trim() === "") return err("query is required");
      try {
        const scoped = args.repoId !== undefined;
        const registry = await deps.getRegistry();
        const res = await hybridSearch(deps.cfg, deps.db, {
          repoId: args.repoId,
          query,
          mode: args.mode ?? "auto",
          limit: args.limit ?? 10,
          style: "code",
          checkouts: await deps.getCheckouts(),
          repoExcludes: repoExcludesFor(deps.cfg, registry),
        });
        const payload = {
          ...(scoped ? { repoId: args.repoId } : {}),
          results: serializeHits(res.results, scoped, repoWebOf(registry)),
          warnings: res.warnings,
        };
        return ok(encode(payload));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "get_wiki_page",
    {
      description:
        "Return the full OKF wiki concept document for a path: YAML frontmatter fields (type, title, description, tags, ...) plus the markdown body, read from the on-disk bundle. Includes the repo overview page. " +
        "Response is a repoId/path identity header followed by the raw markdown file verbatim.",
      inputSchema: {
        repoId: z.string().describe("Repository id (see list_repos)"),
        path: z.string().describe('Concept id, e.g. "overview" or "token-validation"'),
      },
    },
    async (args) => {
      try {
        const chunk = await getChunk(deps.db, args.repoId, "wiki", args.path);
        if (!chunk) return err(`wiki page not found: ${args.repoId}/${args.path}`);
        const raw = await Bun.file(chunk.filePath).text();
        // Identity header via encode() keeps quoting correct for ids with
        // colons/commas; the document below is raw concatenation — serving
        // time only, the bundle file is never touched.
        return ok(`${encode({ repoId: args.repoId, path: args.path })}\n\n${raw}`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "list_related",
    {
      description:
        "List the outgoing and incoming (backlink) edges of a wiki concept, with each neighbor's id, title, and description. Edges are derived from markdown links between concepts. " +
        "Response is TOON text (token-oriented object notation: key/value lines; arrays declare [N] lengths and tabular arrays declare {fields} headers).",
      inputSchema: {
        repoId: z.string().describe("Repository id (see list_repos)"),
        path: z.string().describe('Concept id, e.g. "overview"'),
      },
    },
    async (args) => {
      try {
        const chunk = await getChunk(deps.db, args.repoId, "wiki", args.path);
        if (!chunk) return err(`wiki page not found: ${args.repoId}/${args.path}`);
        const edges = await listEdges(deps.db, args.repoId, args.path);
        const ids = [...edges.outgoing, ...edges.incoming];
        const summaries = await listChunkSummaries(deps.db, args.repoId, ids);
        const neighbor = (id: string) => ({
          id,
          title: summaries.get(id)?.title ?? null,
          description: summaries.get(id)?.description ?? null,
        });
        const payload = {
          repoId: args.repoId,
          path: args.path,
          outgoing: edges.outgoing.map(neighbor),
          incoming: edges.incoming.map(neighbor),
        };
        return ok(encode(payload));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "ask_repo",
    {
      description:
        "Retrieve the most relevant wiki pages / source chunks for a question via hybrid search (vectors + ripgrep). " +
        "Returns RECALL RESULTS ONLY: ranked page identifiers (concept ids usable with get_wiki_page), kind (wiki/source), title, description, a bounded text snippet, score, and citations (file paths with line ranges). " +
        "This tool never synthesizes an answer — combine and answer from the returned snippets yourself, then follow up with get_wiki_page / list_related for full context. " +
        ASK_KEYWORDS_HINT +
        " Omit repoId to route the question across repos via centroids; every result then carries its repoId. " +
        "Response is TOON text (token-oriented object notation: key/value lines; arrays declare [N] lengths and tabular arrays declare {fields} headers).",
      inputSchema: {
        repoId: z
          .string()
          .optional()
          .describe("Scope to one repository; omit for cross-repo question routing"),
        question: z.string().describe("The question (drives vector recall)"),
        keywords: z
          .array(z.string())
          .max(5)
          .optional()
          .describe("Grep-friendly keyword entries (drives lexical recall)"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 5)"),
      },
    },
    async (args) => {
      const question = args.question ?? "";
      if (question.trim() === "") return err("question is required");
      const scoped = args.repoId !== undefined;
      try {
        const registry = await deps.getRegistry();
        const repos = repoWebOf(registry);
        const res = await hybridSearch(deps.cfg, deps.db, {
          repoId: args.repoId,
          query: question,
          entries: args.keywords ?? undefined,
          limit: args.limit ?? 5,
          style: "ask",
          checkouts: await deps.getCheckouts(),
          repoExcludes: repoExcludesFor(deps.cfg, registry),
        });
        if (res.results.length === 0) {
          const scope = args.repoId ? `repo ${args.repoId}` : "the indexed repositories";
          return ok(
            `No relevant content found for this question in ${scope}. Try different keywords or scope explicitly with repoId.`,
          );
        }
        // Honesty note: when nothing cleared the similarity threshold and no
        // lexical matches exist, say so instead of presenting noise as recall.
        const sims = res.results
          .filter((r) => r.vectorSim !== null)
          .map((r) => r.vectorSim as number);
        const belowThreshold =
          res.results.length > 0 &&
          res.results.every((r) => r.vectorSim !== null) &&
          (sims.length === 0 || Math.max(...sims) < deps.cfg.vectorMinSimilarity);
        if (belowThreshold) {
          const scope = args.repoId ? `repo ${args.repoId}` : "the indexed repositories";
          return ok(
            `No relevant content found in ${scope} (best similarity ${Math.max(...sims).toFixed(3)} is below the ${deps.cfg.vectorMinSimilarity} threshold) — these are the closest matches, use with caution:\n\n${encode(serializeHits(res.results.slice(0, 3), scoped, repos))}`,
          );
        }
        // One-hop neighbor context for the top wiki result (navigational aid).
        const top = res.results.find((r) => r.kind === "wiki");
        let neighbors: { id: string; title: string | null }[] = [];
        if (top) {
          const edges = await listEdges(deps.db, top.repoId, top.path);
          const ids = [...edges.outgoing, ...edges.incoming].slice(0, 8);
          const summaries = await listChunkSummaries(deps.db, top.repoId, ids);
          for (const id of ids) {
            neighbors.push({ id, title: summaries.get(id)?.title ?? null });
          }
        }
        const payload = {
          question,
          ...(scoped ? { repoId: args.repoId } : {}),
          results: serializeHits(res.results, scoped, repos),
          warnings: res.warnings,
          ...(neighbors.length > 0 ? { neighbors: { around: top?.path, neighbors } } : {}),
        };
        return ok(encode(payload));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "server_status",
    {
      description:
        'Return the server status summary: scheduler/queue state (pending, in-flight, locks held), aggregate health counts (green/yellow/red), and per-repo health with last error — so you can answer conversational health questions ("why is repo X stale?"). ' +
        "Response is TOON text (token-oriented object notation: key/value lines; arrays declare [N] lengths and tabular arrays declare {fields} headers).",
      inputSchema: {},
    },
    async () => {
      try {
        const summary = await deps.getStatus();
        return ok(encode(summary));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
