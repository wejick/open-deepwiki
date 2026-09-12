import { parseRemote } from "./registry.ts";

/**
 * Forge permalink for a repo-relative cited file, or null when none can be
 * derived: local source, unrecognized host, or no indexed revision. The
 * revision is the commit the wiki was built and indexed at, so the link's line
 * ranges match the page (spec: wiki-viewer › Page sources rendered with forge
 * links; mcp-server › Source citation URLs in search results).
 */
export function webSourceUrl(
  source: string,
  sha: string | null,
  path: string,
  range: { start: number; end: number } | null,
): string | null {
  if (sha === null || sha === "") return null;
  const remote = parseRemote(source);
  if (remote === null) return null;
  const kind = /gitlab/i.test(remote.host)
    ? "gitlab"
    : /github/i.test(remote.host)
      ? "github"
      : null;
  if (kind === null) return null;

  const filePath = path.split("/").map(encodeURIComponent).join("/");
  const repoPath = remote.path.split("/").map(encodeURIComponent).join("/");
  const host = remote.host.toLowerCase();
  const base =
    kind === "gitlab"
      ? `https://${host}/${repoPath}/-/blob/${sha}/${filePath}`
      : `https://${host}/${repoPath}/blob/${sha}/${filePath}`;
  if (range === null || range.start <= 0) return base;
  if (range.end <= range.start) return `${base}#L${range.start}`;
  return kind === "gitlab"
    ? `${base}#L${range.start}-${range.end}`
    : `${base}#L${range.start}-L${range.end}`;
}
