# session-store

A tiny in-memory session store: fixed-capacity LRU eviction (`src/cache.ts`)
wrapped with lazy TTL expiry (`src/store.ts`), used by `src/index.ts` to track
logged-in sessions.
