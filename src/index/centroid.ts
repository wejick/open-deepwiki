import type { Client } from "@libsql/client";
import { listChunks, setRepoMeta } from "./db.ts";

/**
 * Repo concept derivation (3.7): auto-derived concept terms (aggregated wiki
 * `tags`, `type` values, and frequent title/description terms — zero manual
 * tagging) plus a centroid embedding (mean of wiki concept vectors, overview
 * page included). Recomputed after every (re-)index.
 */

const STOPWORDS = new Set(
  // tokenize() drops 1-2 char tokens before this set is consulted.
  "and are been being but can did does for from get got has have had her hers him his how into its just made make makes more most new nor not now only other our ours out over own same she some such than that the their them then there these they this those too under until use used uses using very was were what when where which while who why will with work would you your yours".split(
    " ",
  ),
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []).filter(
    (t) => !STOPWORDS.has(t) && t.length > 2,
  );
}

export async function deriveRepoMeta(
  db: Client,
  repoId: string,
  opts: { dim: number; linkResolved: number; linkTotal: number },
): Promise<void> {
  const chunks = await listChunks(db, repoId, "wiki");
  const counter = new Map<string, number>();
  const bump = (term: string, weight: number) =>
    counter.set(term, (counter.get(term) ?? 0) + weight);

  for (const c of chunks) {
    let fm: Record<string, unknown> = {};
    try {
      fm = c.frontmatter ? (JSON.parse(c.frontmatter) as Record<string, unknown>) : {};
    } catch {
      // not JSON — ignore
    }
    const tags = Array.isArray(fm.tags)
      ? (fm.tags as unknown[]).filter((t) => typeof t === "string")
      : [];
    for (const t of tags) bump(String(t).toLowerCase(), 3);
    if (typeof fm.type === "string" && fm.type.trim() !== "") {
      for (const t of tokenize(fm.type)) bump(t, 2);
    }
    for (const t of tokenize(`${c.title ?? ""} ${c.description ?? ""}`)) bump(t, 1);
  }

  const terms = [...counter.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([t]) => t);

  // Centroid = mean of wiki chunk vectors (empty vectors tolerated).
  const r = await db.execute({
    sql: `SELECT v.vec FROM vectors v JOIN chunks c ON c.id = v.chunk_id
          WHERE c.repo_id = ? AND c.kind = 'wiki'`,
    args: [repoId],
  });
  let centroid: number[] | null = null;
  if (r.rows.length > 0) {
    const dim = opts.dim;
    const sum = Array.from({ length: dim }, () => 0);
    for (const row of r.rows) {
      const v = new Float32Array(row.vec as ArrayBuffer);
      for (let d = 0; d < dim; d++) sum[d] = (sum[d] ?? 0) + (v[d] ?? 0);
    }
    centroid = sum.map((x) => x / r.rows.length);
  }

  await setRepoMeta(db, {
    repoId,
    conceptTerms: terms,
    centroid,
    linkResolved: opts.linkResolved,
    linkTotal: opts.linkTotal,
  });
}
