/* Sharded `bun test`: bun runs test files sequentially inside one process, so a
 * single `bun test ./src ./test` leaves the CPU idle while suites wait on child
 * processes (git, shims, libsql). This fans the files out over a few `bun test`
 * processes. Tests are parallel-safe: every test builds its own tmpdirs.
 *
 * `WEIGHT` holds measured solo wall-times (seconds). Files under 1s are omitted
 * and weigh 1; re-measure with
 * `/usr/bin/time -p bun test <file> 2>&1 >/dev/null` when the suite changes. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEIGHT: Record<string, number> = {
  "src/repoManager/producerPipeline.test.ts": 28,
  "src/producer/claudeInitPlan.test.ts": 22,
  "src/producer/claudePool.test.ts": 17,
  "src/producer/claudeCheckpoint.test.ts": 16,
  "src/server/admin.test.ts": 11,
  "src/producer/wip.test.ts": 10,
  "src/producer/claude.test.ts": 10,
  "src/repoManager/repoManager.test.ts": 9,
  "src/producer/acceptance.test.ts": 7,
  "src/producer/producer.test.ts": 4,
  "src/producer/continuation.test.ts": 4,
  "src/producer/claudeDigest.test.ts": 4,
  "src/index/search.test.ts": 3,
  "src/index/index.test.ts": 2,
  "src/repoManager/registry-instructions.test.ts": 2,
  "test/e2e.test.ts": 2,
  "src/server/wiki.test.ts": 2,
  "src/server/server.test.ts": 2,
};

const args = process.argv.slice(2);
function isPath(a: string): boolean {
  try {
    statSync(a);
    return true;
  } catch {
    return false;
  }
}
// A bare arg is a file/dir filter only if it exists; anything else (including
// values that follow flags, like `--timeout 20000`) goes to each `bun test`.
const roots = args.filter(isPath);
const flags = args.filter((a) => !roots.includes(a));

function listTests(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory() && e.name !== "node_modules") return listTests(join(dir, e.name));
    if (e.isFile() && e.name.endsWith(".test.ts")) return [join(dir, e.name)];
    return [];
  });
}

const files = (roots.length > 0 ? roots : ["src", "test"]).flatMap((r) =>
  statSync(r).isDirectory() ? listTests(r) : [r],
);

// Eight: each shard is spawn/fs-heavy, and past this macOS fork cost inflates
// every shard faster than the extra parallelism pays (measured 6 → ~70s,
// 8 → ~60s). Revisit only after cutting child-process spawns.
const shardCount = 8;
const shards = Array.from({ length: shardCount }, () => ({ files: [] as string[], weight: 0 }));
for (const f of [...files].sort((a, b) => (WEIGHT[b] ?? 1) - (WEIGHT[a] ?? 1))) {
  const lightest = shards.reduce((m, s) => (s.weight < m.weight ? s : m));
  lightest.files.push(f);
  lightest.weight += WEIGHT[f] ?? 1;
}

async function pipeTagged(stream: ReadableStream<Uint8Array>, tag: string): Promise<void> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) console.log(`${tag} ${l}`);
  }
  if (buf !== "") console.log(`${tag} ${buf}`);
}

const started = Date.now();
const runs = shards
  .filter((s) => s.files.length > 0)
  .map((s, i) => {
    const tag = `[shard${i}]`;
    const t0 = Date.now();
    const p = Bun.spawn(["bun", "test", ...flags, ...s.files], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([pipeTagged(p.stdout, tag), pipeTagged(p.stderr, tag)]).then(async () => ({
      code: await p.exited,
      seconds: (Date.now() - t0) / 1000,
      files: s.files,
    }));
  });

const done = await Promise.all(runs);
const failed = done.filter((r) => r.code !== 0);
console.log(
  `shards: ${done.length} (${shardCount} requested) · ${files.length} files · ` +
    `${((Date.now() - started) / 1000).toFixed(1)}s · failed shards: ${failed.length}`,
);
for (const r of done) console.log(`  shard ${r.files.length} files · ${r.seconds.toFixed(1)}s`);
for (const f of failed) console.log(`FAILED: bun test ${f.files.join(" ")}`);
process.exit(failed.length > 0 ? 1 : 0);
