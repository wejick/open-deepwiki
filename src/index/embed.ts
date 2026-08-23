import type { Config } from "../config/config.ts";

/**
 * Embeddings client (3.4): single OpenAI-compatible endpoint
 * (`POST {baseUrl}/embeddings` — OpenRouter or any local server). Vectors are
 * truncated/padded to the configured dimension (≤512 default per D5).
 * When the provider is unavailable the caller degrades to metadata-only
 * indexing (lexical search keeps working) and logs a warning.
 */

const BATCH_SIZE = 64;

export async function embedTexts(cfg: Config, texts: string[]): Promise<number[][] | null> {
  if (!cfg.llm.apiKey || texts.length === 0) return null;
  const url = `${cfg.llm.baseUrl.replace(/\/+$/, "")}/embeddings`;
  const dim = cfg.embedding.dim;
  const out: number[][] = [];

  try {
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.llm.apiKey}`,
        },
        body: JSON.stringify({ model: cfg.embedding.model, input: batch }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: { embedding?: number[] }[] };
      for (const item of body.data ?? []) {
        const v = item.embedding ?? [];
        // Truncate or zero-pad to the configured dimension.
        const vec = Array.from({ length: dim }, () => 0);
        for (let d = 0; d < dim; d++) vec[d] = v[d] ?? 0;
        out.push(vec);
      }
    }
  } catch {
    return null; // provider unavailable — metadata-only indexing
  }
  return out.length === texts.length ? out : null;
}
