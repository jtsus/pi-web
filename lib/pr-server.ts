import { execFile } from "child_process";
import { promisify } from "util";
import {
  findOpenPullForBranch,
  getPull,
  getPullDetail,
  hasGitHubToken,
  listOpenPulls,
  mergePull,
  summarizePulls,
} from "./gh-api";
import { isGitHubHost, normalizeRepoSlug, parseGitHubRemote } from "./git-remote";
import { dominantRepo, linkKey, pullRequestLinksFromEntries } from "./pr-links";
import {
  type PullRequestDetail,
  type PullRequestLink,
  type PullRequestListResponse,
  type PullRequestMergeMethod,
  type PullRequestMergeResponse,
  type PullRequestScope,
} from "./pr-types";
import { isVisiblePullRequest, sortPullRequests } from "./pr-view";
import { getSessionEntries, readSessionHeader, resolveSessionPath } from "./session-reader";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

export class PullRequestRequestError extends Error {
  readonly status: number;
  readonly code: "no-repo" | "no-token" | "no-session" | "not-found";
  constructor(message: string, status: number, code: "no-repo" | "no-token" | "no-session" | "not-found") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

/** `owner/repo` of the github.com remote behind a checkout, or null. */
export async function resolveGitHubRepoForCwd(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  for (const remote of ["origin", "upstream"]) {
    try {
      const url = (await git(cwd, ["remote", "get-url", remote])).trim();
      const parsed = parseGitHubRemote(url);
      if (parsed && isGitHubHost(parsed.host)) return parsed.repo;
    } catch {
      // No such remote, or not a git checkout: try the next one.
    }
  }
  return null;
}

export async function sessionPullRequestLinks(sessionId: string | null): Promise<{
  links: PullRequestLink[];
  cwd: string | null;
}> {
  if (!sessionId) return { links: [], cwd: null };
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return { links: [], cwd: null };
  const header = readSessionHeader(filePath);
  let entries: unknown[] = [];
  try {
    entries = getSessionEntries(filePath) as unknown[];
  } catch {
    entries = [];
  }
  return { links: pullRequestLinksFromEntries(entries), cwd: header?.cwd ?? null };
}

/**
 * The PRs one panel request should show.
 *
 * `session` scope lists only what this chat's agent recorded, `all` lists every
 * open PR of the project's repository. Merged and closed PRs are dropped in
 * both scopes: the panel is about work that still needs attention.
 */
export async function listPullRequests(options: {
  sessionId: string | null;
  cwd: string | null;
  scope: PullRequestScope;
}): Promise<PullRequestListResponse> {
  const session = await sessionPullRequestLinks(options.sessionId);
  const cwd = options.cwd ?? session.cwd;
  const repo = dominantRepo(session.links) ?? (cwd ? await resolveGitHubRepoForCwd(cwd) : null);
  const base: PullRequestListResponse = {
    scope: options.scope,
    sessionId: options.sessionId,
    cwd,
    repo,
    prs: [],
  };

  if (options.scope === "session" && !session.links.length) return base;
  if (!repo) return base;
  if (!hasGitHubToken()) {
    return {
      ...base,
      error: { code: "no-token", message: "No GitHub token found. Add one to ~/.pi-git-credentials or set GITHUB_TOKEN." },
    };
  }

  try {
    if (options.scope === "session") {
      const pulls = await Promise.all(session.links.map(async (link) => {
        try {
          const pull = await getPull(link.repo, link.number);
          const [summary] = await summarizePulls(link.repo, [pull], session.links);
          return summary;
        } catch {
          // A deleted repo or a revoked token must not hide the other PRs.
          return null;
        }
      }));
      const prs = pulls.filter((pr): pr is NonNullable<typeof pr> => Boolean(pr)).filter(isVisiblePullRequest);
      return { ...base, prs: sortPullRequests(prs) };
    }

    const open = await listOpenPulls(repo);
    const summaries = await summarizePulls(repo, open, session.links);
    return { ...base, prs: sortPullRequests(summaries.filter(isVisiblePullRequest)) };
  } catch (error) {
    return {
      ...base,
      error: { code: "github", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function pullRequestDetail(options: {
  repo: string;
  number: number;
  sessionId: string | null;
}): Promise<PullRequestDetail> {
  const repo = normalizeRepoSlug(options.repo);
  if (!repo) throw new PullRequestRequestError("repo must be owner/name", 400, "no-repo");
  if (!hasGitHubToken()) {
    throw new PullRequestRequestError("No GitHub token found", 400, "no-token");
  }
  const { links } = await sessionPullRequestLinks(options.sessionId);
  const link = links.find((entry) => linkKey(entry.repo, entry.number) === linkKey(repo, options.number));
  try {
    return await getPullDetail(repo, options.number, link);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 0;
    if (status === 404) throw new PullRequestRequestError("Pull request not found", 404, "not-found");
    throw error;
  }
}

export async function mergePullRequest(options: {
  repo: string;
  number: number;
  method: PullRequestMergeMethod;
}): Promise<PullRequestMergeResponse> {
  const repo = normalizeRepoSlug(options.repo);
  if (!repo) throw new PullRequestRequestError("repo must be owner/name", 400, "no-repo");
  if (!hasGitHubToken()) {
    throw new PullRequestRequestError("No GitHub token found", 400, "no-token");
  }
  return mergePull(repo, options.number, options.method);
}

/**
 * Shipping support for surfaces that are not the agent extension: find the open
 * PR an agent opened for a branch, so a second ship call reuses it.
 */
export async function openPullForBranch(repo: string, branch: string): Promise<number | null> {
  const pull = await findOpenPullForBranch(repo, branch);
  return pull?.number ?? null;
}
