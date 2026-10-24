/** Pure helpers: a git remote URL or a repo slug → `owner/repo` on github.com. */

export interface GitHubRepoRef {
  /** Lowercase-insensitive `owner/name` slug as GitHub reports it. */
  repo: string;
  host: string;
}

const REPO_PART = /^[A-Za-z0-9._-]+$/;
const HOST_PART = /^[A-Za-z0-9.-]+$/;

function cleanRepoPart(part: string): string | null {
  const withoutGit = part.replace(/\.git$/i, "");
  if (!withoutGit || !REPO_PART.test(withoutGit)) return null;
  // "." and ".." pass the character test but are not repo names.
  if (withoutGit === "." || withoutGit === "..") return null;
  return withoutGit;
}

/**
 * Accepts the shapes `git remote get-url origin` produces:
 * `https://github.com/owner/repo.git`, `git@github.com:owner/repo.git`,
 * `ssh://git@github.com/owner/repo`, `git://github.com/owner/repo`.
 * Returns null for anything that is not a two-part path with a host.
 */
export function parseGitHubRemote(remoteUrl: string | null | undefined): GitHubRepoRef | null {
  const raw = remoteUrl?.trim();
  if (!raw) return null;

  let host: string | undefined;
  let path: string | undefined;

  const scpLike = /^(?:[^@/]+@)?([^:/@]+):(?!\/)(.+)$/.exec(raw);
  if (scpLike && !raw.includes("://")) {
    host = scpLike[1];
    path = scpLike[2];
  } else {
    try {
      const url = new URL(raw);
      host = url.hostname;
      path = url.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  }

  if (!host || !path) return null;
  const normalizedHost = host.toLowerCase();
  if (!HOST_PART.test(normalizedHost)) return null;

  const segments = path.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = cleanRepoPart(segments[segments.length - 2]);
  const name = cleanRepoPart(segments[segments.length - 1]);
  if (!owner || !name) return null;

  return { repo: `${owner}/${name}`, host: normalizedHost };
}

/** Normalizes a user- or API-supplied slug (`owner/name`, trailing `.git` tolerated). */
export function normalizeRepoSlug(slug: string | null | undefined): string | null {
  const trimmed = slug?.trim();
  if (!trimmed) return null;
  const segments = trimmed.replace(/^\/+/, "").split("/");
  if (segments.length !== 2) return null;
  const owner = cleanRepoPart(segments[0]);
  const name = cleanRepoPart(segments[1]);
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

/** True when the remote is a GitHub host this app talks to. */
export function isGitHubHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "github.com" || normalized === "www.github.com";
}
