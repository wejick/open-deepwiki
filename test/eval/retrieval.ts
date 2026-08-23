import matter from "gray-matter";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { RESERVED_NAMES, walkMd } from "../../src/producer/verify.ts";
import { citedPaths } from "../../src/producer/grounding.ts";
import { openDb } from "../../src/index/db.ts";
import { indexRepo } from "../../src/index/update.ts";
import { hybridSearch } from "../../src/index/search.ts";
import type { Config } from "../../src/config/config.ts";

/** gray-matter caches by content string, and a throw leaves a poisoned `{}`
 *  entry that later returns empty frontmatter. An options object skips it. */
const NO_MATTER_CACHE = {} as const;

/**
 * Does a bundle actually help you find the right code? Indexes it with the
 * repo's sources, runs the golden questions through `hybridSearch`, and scores
 * recall@5 and MRR against source-path answer keys.
 *
 * Unlike the rest of the harness this embeds the query, so it is opt-in
 * (`--questions`) and `bun run eval` stays offline by default.
 */

export type Question = {
  question: string;
  /** Optional lexical side; terms within one keyword are ANDed. */
  keywords?: string[];
  /** Repo-relative source paths that should be retrieved. */
  answers: string[];
};

export type QuestionSet = { note?: string; questions: Question[] };

export type RetrievalResult = {
  questions: number;
  /** Mean fraction of a question's answers found in the top 5. */
  recallAt5: number;
  /** Mean reciprocal rank of the first matching hit. */
  mrr: number;
  /** Questions where nothing relevant was retrieved at all. */
  misses: string[];
};

const LIMIT = 10;

export async function loadQuestions(path: string): Promise<Question[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as QuestionSet | Question[];
  const questions = Array.isArray(parsed) ? parsed : parsed.questions;
  if (!Array.isArray(questions)) throw new Error(`${path}: expected a questions array`);
  for (const q of questions) {
    if (typeof q.question !== "string" || !Array.isArray(q.answers)) {
      throw new Error(`${path}: every entry needs { question, answers[] }`);
    }
  }
  return questions;
}

/** Copy the checkout with `bundle` standing in as its `openwiki/`, so A and B
 *  index against identical sources. `.git` is skipped; nothing reads it. */
async function stageCheckout(checkout: string, bundle: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "odw-eval-idx-"));
  const staged = join(dir, "checkout");
  await cp(checkout, staged, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      return name !== ".git" && name !== "openwiki";
    },
  });
  await cp(bundle, join(staged, "openwiki"), { recursive: true });
  return dir;
}

/** page id -> source paths it cites, for answer-key matching. */
async function citationsByPage(bundle: string): Promise<Map<string, Set<string>>> {
  const files = (await walkMd(bundle)).filter(
    (f) => !RESERVED_NAMES.has(f.split("/").at(-1) ?? ""),
  );
  const out = new Map<string, Set<string>>();
  for (const rel of files) {
    try {
      const parsed = matter(await readFile(join(bundle, rel), "utf8"), NO_MATTER_CACHE);
      out.set(rel.replace(/\.md$/, ""), new Set(citedPaths(parsed.data)));
    } catch {
      continue;
    }
  }
  return out;
}

export async function scoreRetrieval(
  bundle: string,
  checkout: string,
  cfg: Config,
  questions: Question[],
): Promise<RetrievalResult> {
  if (questions.length === 0) {
    return { questions: 0, recallAt5: 0, mrr: 0, misses: [] };
  }
  const cites = await citationsByPage(bundle);
  const staging = await stageCheckout(checkout, bundle);
  const stagedCheckout = join(staging, "checkout");

  try {
    const db = await openDb(join(staging, "index.db"), { dim: cfg.embedding.dim });
    await indexRepo(db, cfg, "eval", stagedCheckout);

    let recallSum = 0;
    let rrSum = 0;
    const misses: string[] = [];

    for (const q of questions) {
      const res = await hybridSearch(cfg, db, {
        repoId: "eval",
        query: q.question,
        ...(q.keywords === undefined ? {} : { entries: q.keywords }),
        limit: LIMIT,
        style: "ask",
        checkouts: new Map([["eval", stagedCheckout]]),
      });

      // Relevant if it IS the answer file, or a page citing it.
      const relevantAt = (i: number): string[] => {
        const hit = res.results[i];
        if (hit === undefined) return [];
        const cited = hit.kind === "wiki" ? (cites.get(hit.path) ?? new Set()) : new Set<string>();
        return q.answers.filter((a) => hit.path === a || cited.has(a));
      };

      const foundInTop5 = new Set<string>();
      for (let i = 0; i < Math.min(5, res.results.length); i++) {
        for (const a of relevantAt(i)) foundInTop5.add(a);
      }
      recallSum += q.answers.length === 0 ? 0 : foundInTop5.size / q.answers.length;

      let rank = 0;
      for (let i = 0; i < res.results.length; i++) {
        if (relevantAt(i).length > 0) {
          rank = i + 1;
          break;
        }
      }
      if (rank === 0) misses.push(q.question);
      else rrSum += 1 / rank;
    }

    return {
      questions: questions.length,
      recallAt5: recallSum / questions.length,
      mrr: rrSum / questions.length,
      misses: misses.toSorted(),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
