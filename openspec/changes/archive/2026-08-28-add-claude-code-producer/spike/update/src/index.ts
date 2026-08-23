import { Store } from "./store.ts";
import { shortId } from "./format.ts";

/** Demo entrypoint: a 100-entry, 60-second-TTL store for session tokens. */
const sessions = new Store<{ userId: string }>(100, 60_000);

export function login(sessionId: string, userId: string): void {
  sessions.set(sessionId, { userId });
  console.log(`login: ${shortId(sessionId)}`);
}

export function currentUser(sessionId: string): string | undefined {
  return sessions.get(sessionId)?.userId;
}
