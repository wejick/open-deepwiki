import { mkdir } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { paths, type Config } from "../config/config.ts";
import { openDb } from "../index/db.ts";
import { loadRegistry, type Registry } from "./registry.ts";

/** Shared runtime context: config + writable index DB + registry. */
export type Ctx = {
  cfg: Config;
  db: Client;
  registry: Registry;
};

export async function openContext(cfg: Config): Promise<Ctx> {
  await mkdir(paths.data(cfg), { recursive: true });
  const db = await openDb(paths.indexDb(cfg), { dim: cfg.embedding.dim });
  const registry = await loadRegistry(cfg);
  return { cfg, db, registry };
}
