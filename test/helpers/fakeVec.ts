/**
 * Deterministic fake embeddings for offline tests: bag-of-words over
 * stemmed tokens hashed into each dimension. Documents sharing word stems get
 * close vectors; unrelated text stays apart. No network, fully reproducible.
 */
export function fakeVec(text: string, dim = 16): number[] {
  const v = Array.from({ length: dim }, () => 0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
    .map(stem);
  for (const token of tokens) {
    for (let d = 0; d < dim; d++) {
      v[d] = (v[d] ?? 0) + (hashDim(token, d) % 2 === 0 ? 1 : -1);
    }
  }
  return normalize(v);
}

/** Light stem so "authentication" and "authenticating" share a token. */
function stem(token: string): string {
  if (token.endsWith("ing")) return token.slice(0, -3);
  if (token.endsWith("ion")) return token.slice(0, -3);
  if (token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Scramble token hash by dimension. (Plain FNV-1a over `<token>:<d>` fails:
 * XORing the final decimal digit makes the parity alternate with d, so token
 * patterns cancel pairwise.) Murmur3-style finalizer breaks that linearity.
 */
function hashDim(token: string, d: number): number {
  const h = fnv1a(token);
  let x = (h ^ Math.imul(d + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum);
  if (len === 0) return v;
  return v.map((x) => x / len);
}

import { cosine } from "../../src/index/vector.ts";

export function cosineSimilarity(a: number[], b: number[]): number {
  return cosine(a, b);
}
