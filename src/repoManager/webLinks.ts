import { parseRemote } from "./registry.ts";

type Forge = { kind: "github" | "gitlab"; base: string; sha: string };

function forgeFor(source: string, sha: string | null): Forge | null {
  if (sha === null || sha === "") return null;
  const remote = parseRemote(source);
  if (remote === null) return null;
  const kind = /gitlab/i.test(remote.host)
    ? "gitlab"
    : /github/i.test(remote.host)
      ? "github"
      : null;
  if (kind === null) return null;
  const repoPath = remote.path.split("/").map(encodeURIComponent).join("/");
  return { kind, base: `https://${remote.host.toLowerCase()}/${repoPath}`, sha };
}

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
  const forge = forgeFor(source, sha);
  if (forge === null) return null;

  const filePath = path.split("/").map(encodeURIComponent).join("/");
  const base = `${forge.base}/${forge.kind === "gitlab" ? "-/blob" : "blob"}/${forge.sha}/${filePath}`;
  if (range === null || range.start <= 0) return base;
  if (range.end <= range.start) return `${base}#L${range.start}`;
  return forge.kind === "gitlab"
    ? `${base}#L${range.start}-${range.end}`
    : `${base}#L${range.start}-L${range.end}`;
}

/**
 * Forge commit page for the indexed revision, or null when none can be
 * derived (spec: wiki-viewer › Indexed revision linked).
 */
export function webCommitUrl(source: string, sha: string | null): string | null {
  const forge = forgeFor(source, sha);
  if (forge === null) return null;
  return forge.kind === "gitlab"
    ? `${forge.base}/-/commit/${forge.sha}`
    : `${forge.base}/commit/${forge.sha}`;
}
