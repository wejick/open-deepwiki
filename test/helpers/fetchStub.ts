import { fakeVec } from "./fakeVec.ts";

/**
 * Stub `globalThis.fetch` for the embeddings endpoint only (the sole network
 * boundary in the index). Deterministic fakeVec vectors make vector search,
 * RRF ordering, and centroid routing assertable offline. Returns restore().
 */

export type EmbeddingsCall = { texts: string[] };

export function stubFakeVecEmbeddings(dim: number): {
  restore: () => void;
  calls: EmbeddingsCall[];
} {
  const calls: EmbeddingsCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/embeddings")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
      const texts = Array.isArray(body.input)
        ? body.input
        : body.input !== undefined
          ? [body.input]
          : [];
      calls.push({ texts });
      return new Response(
        JSON.stringify({
          data: texts.map((text) => ({ embedding: fakeVec(text, dim) })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return original(input, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Stub that simulates an unreachable embedding provider (any call fails). */
export function stubFailingEmbeddings(): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/embeddings")) {
      throw new TypeError("fetch failed: connection refused");
    }
    return original(input);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
