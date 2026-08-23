import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadQuestions, scoreRetrieval, type Question } from "./retrieval.ts";
import { testConfig } from "../helpers/config.ts";
import { stubFakeVecEmbeddings } from "../helpers/fetchStub.ts";
import { makeTmp, rmTmp } from "../helpers/tmp.ts";

/**
 * Retrieval parity verification (1.3). Uses the deterministic fakeVec
 * embedding stub, so the expected ranking is known and the test stays offline.
 */

const FIXTURES = fileURLToPath(new URL("../fixtures/grounding", import.meta.url));
const checkout = join(FIXTURES, "checkout");
const bundle = (name: string): string => join(FIXTURES, name);
const QUESTIONS = fileURLToPath(new URL("./questions.json", import.meta.url));

let cleanups: (() => void)[] = [];
let tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await makeTmp();
  tmpDirs.push(d);
  return d;
}
afterEach(async () => {
  for (const c of cleanups) c();
  cleanups = [];
  await Promise.all(tmpDirs.map(rmTmp));
  tmpDirs = [];
});

/** The seeded set: each question's wording shares stems with its answer file. */
const SEEDED: Question[] = [
  { question: "How are tokens validated?", keywords: ["token"], answers: ["src/auth.ts"] },
  { question: "How long do cache entries live?", keywords: ["cache"], answers: ["src/cache.ts"] },
];

describe("loadQuestions", () => {
  test("reads the shipped question set", async () => {
    const qs = await loadQuestions(QUESTIONS);
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      expect(typeof q.question).toBe("string");
      expect(Array.isArray(q.answers)).toBe(true);
    }
  });

  test("rejects a malformed set rather than scoring nonsense", async () => {
    const dir = await tmp();
    const bad = join(dir, "bad.json");
    await Bun.write(bad, JSON.stringify({ questions: [{ question: "no answers" }] }));
    await expect(loadQuestions(bad)).rejects.toThrow(/question, answers/);
  });
});

describe("retrieval parity", () => {
  test("a grounded bundle retrieves the expected source for every question", async () => {
    const cfg = testConfig(await tmp());
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const res = await scoreRetrieval(bundle("bundle-grounded"), checkout, cfg, SEEDED);

    expect(res.questions).toBe(2);
    // Both answer files exist and are indexed as sources, and the bundle's
    // pages cite them — the expected hit is reachable either way.
    expect(res.recallAt5).toBe(1);
    expect(res.mrr).toBeGreaterThan(0);
    expect(res.misses).toEqual([]);
  });

  test("an empty question set scores zero without touching the index", async () => {
    const cfg = testConfig(await tmp());
    const res = await scoreRetrieval(bundle("bundle-grounded"), checkout, cfg, []);
    expect(res).toEqual({ questions: 0, recallAt5: 0, mrr: 0, misses: [] });
  });

  test("an unanswerable question is recorded as a miss, not silently averaged away", async () => {
    const cfg = testConfig(await tmp());
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const res = await scoreRetrieval(bundle("bundle-grounded"), checkout, cfg, [
      { question: "How does the billing ledger reconcile invoices?", answers: ["src/billing.ts"] },
    ]);

    expect(res.recallAt5).toBe(0);
    expect(res.mrr).toBe(0);
    expect(res.misses).toEqual(["How does the billing ledger reconcile invoices?"]);
  });

  test("scoring is repeatable for the same bundle and question set", async () => {
    const cfg = testConfig(await tmp());
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    const first = await scoreRetrieval(bundle("bundle-grounded"), checkout, cfg, SEEDED);
    const second = await scoreRetrieval(bundle("bundle-grounded"), checkout, cfg, SEEDED);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("the staged index does not touch the original checkout", async () => {
    const cfg = testConfig(await tmp());
    const stub = stubFakeVecEmbeddings(cfg.embedding.dim);
    cleanups.push(stub.restore);

    await scoreRetrieval(bundle("bundle-grounded"), checkout, cfg, SEEDED);

    // The fixture checkout must not have gained a bundle or an index.
    expect(await Bun.file(join(checkout, "openwiki", "index.md")).exists()).toBe(false);
    expect(await Bun.file(join(checkout, "index.db")).exists()).toBe(false);
  });
});
