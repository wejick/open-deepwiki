import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * The producer contract is written down, not typed — none of its four rules is
 * a shape a compiler can check. These two invariants keep it honest: if either
 * fails, the branch has started spreading. Asserted against the source text
 * rather than by importing modules, because the property under test is
 * literally "this string does not appear here".
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Files that decide whether a bundle is ACCEPTED. None may know which producer
 *  wrote it — parity comes from one code path, not from trusting a prompt. */
const ACCEPTANCE_FILES = [
  "producer/verify.ts",
  "producer/grounding.ts",
  "producer/anchor.ts",
  "producer/acceptance.ts",
];

/** Every producer id that must not appear in acceptance code. */
const PRODUCER_NAMES = ["openwiki", "claude"];

async function sourceFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) await sourceFiles(abs, acc);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) acc.push(abs);
  }
  return acc;
}

/** Strip comments only. String literals are KEPT: a producer id used as a value
 *  is exactly what is being detected, so blanking strings would erase it. */
function codeOnly(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
}

describe("Producer contract invariants", () => {
  test("nothing under acceptance names a producer", async () => {
    const offenders: string[] = [];
    for (const rel of ACCEPTANCE_FILES) {
      const code = codeOnly(await readFile(join(SRC, rel), "utf8"));
      for (const name of PRODUCER_NAMES) {
        // `"openwiki"` as the bundle DIRECTORY is not naming a producer. What
        // is banned is branching on an id, in either operand order.
        for (const pattern of [
          new RegExp(`(?:===|!==|==|!=)\\s*["'\`]${name}["'\`]`),
          new RegExp(`["'\`]${name}["'\`]\\s*(?:===|!==|==|!=)`),
          new RegExp(`case\\s+["'\`]${name}["'\`]`),
        ]) {
          if (pattern.test(code)) offenders.push(`${rel}: branches on "${name}"`);
        }
      }
      expect(code).not.toContain("ProducerId");
    }
    expect(offenders).toEqual([]);
  });

  test("producer selection appears in exactly one place", async () => {
    const files = await sourceFiles(SRC);
    const branching: string[] = [];
    for (const abs of files) {
      const code = codeOnly(await readFile(abs, "utf8"));
      // The one legitimate branch lives in run.ts.
      if (/producerId\s*===/.test(code)) branching.push(abs.slice(SRC.length));
    }
    expect(branching).toEqual(["producer/run.ts"]);
  });

  test("selection is resolved in exactly one place", async () => {
    const files = await sourceFiles(SRC);
    const definitions: string[] = [];
    for (const abs of files) {
      const text = await readFile(abs, "utf8");
      if (/export function producerFor\b/.test(text)) definitions.push(abs.slice(SRC.length));
    }
    expect(definitions).toEqual(["repoManager/registry.ts"]);
  });

  test("the claude-only finalize pass has no producer branching of its own", async () => {
    // finalize.ts is scoped to the claude producer by construction — it is
    // called from exactly one place, inside claude.ts — not by a runtime
    // check of its own. It has no legitimate reason to reference a producer
    // id at all.
    const code = codeOnly(await readFile(join(SRC, "producer/claudeFinalize.ts"), "utf8"));
    expect(code).not.toContain("ProducerId");
    for (const name of PRODUCER_NAMES) {
      for (const pattern of [
        new RegExp(`(?:===|!==|==|!=)\\s*["'\`]${name}["'\`]`),
        new RegExp(`["'\`]${name}["'\`]\\s*(?:===|!==|==|!=)`),
      ]) {
        expect(pattern.test(code)).toBe(false);
      }
    }
  });

  test("the claude-only finalize pass is imported from exactly one place", async () => {
    // Mirrors "producer selection appears in exactly one place": the
    // guarantee that finalize.ts only ever touches a claude-produced bundle
    // rests entirely on it being called from nowhere but the claude
    // producer's run module. A second import site would let it reach an
    // openwiki bundle undetected.
    const files = await sourceFiles(SRC);
    const importers: string[] = [];
    const pattern =
      /import\s*\{[^}]*\b(?:finalizeClaudeBundle|syncIndexes|degradeInvalidMermaidFences)\b[^}]*\}\s*from\s*["'][^"']*claudeFinalize\.ts["']/;
    for (const abs of files) {
      const code = await readFile(abs, "utf8");
      if (pattern.test(code)) importers.push(abs.slice(SRC.length));
    }
    expect(importers).toEqual(["producer/claudeRun.ts"]);
  });

  test("the four rules are recorded in the source, not only in the design", async () => {
    const contract = await readFile(join(SRC, "producer/CONTRACT.md"), "utf8");
    // Each rule must be findable by someone reading the producer directory.
    expect(contract).toContain("openwiki/");
    expect(contract).toContain(".last-update.json");
    expect(contract).toContain("type");
    expect(contract).toContain("one outcome");
    expect(contract.toLowerCase()).toContain("acceptance is not");
  });
});
