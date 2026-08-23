/** Formats a session id for log lines: first 8 chars + ellipsis. */
export function shortId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 8)}…`;
}
