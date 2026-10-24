import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

const API = "https://api.github.com";
const TIMEOUT_MS = 20_000;

export interface RepoRef {
  repo: string;
  host: string;
}

/** Same shapes as the web app: https, scp-style ssh, and ssh:// remotes. */
export function parseRepoRemote(remoteUrl: string | null | undefined): RepoRef | null {
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
  const segments = path.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const clean = (part: string) => part.replace(/\.git$/i, "");
  const owner = clean(segments[segments.length - 2]);
  const name = clean(segments[segments.length - 1]);
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return { repo: `${owner}/${name}`, host: host.toLowerCase() };
}

export function tokenFromCredentialStore(contents: string, host = "github.com"): string | null {
  for (const line of contents.split(/\r?\n/)) {
    const match = /^https?:\/\/([^:@/]+):([^@/]+)@([^/]+)\/?$/.exec(line.trim());
    if (!match || match[3].toLowerCase() !== host) continue;
    const secret = decodeURIComponent(match[2]);
    // A token never contains whitespace; a stray space means a hand-edited line.
    if (secret && !/\s/.test(secret)) return secret;
  }
  return null;
}

/** `HOME` is not always the account's home in a container; the agent dir is. */
export function candidateHomeDirs(): string[] {
  const dirs = new Set<string>();
  // The agent dir is <home>/.pi/agent, so the home is two levels up; add both
  // in case an operator points PI_CODING_AGENT_DIR somewhere shallower.
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) {
    dirs.add(dirname(agentDir));
    dirs.add(dirname(dirname(agentDir)));
  }
  for (const candidate of [process.env.HOME?.trim(), safe(() => homedir()), safe(() => userInfo().homedir)]) {
    if (candidate) dirs.add(candidate);
  }
  return [...dirs];
}

function safe<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export function resolveToken(): string | null {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "PI_WEB_GITHUB_TOKEN"]) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  for (const home of candidateHomeDirs()) {
    for (const file of [".pi-git-credentials", ".git-credentials"]) {
      const path = join(home, file);
      if (!existsSync(path)) continue;
      try {
        const token = tokenFromCredentialStore(readFileSync(path, "utf8"));
        if (token) return token;
      } catch {
        // Unreadable store: try the next one.
      }
    }
  }
  return null;
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = resolveToken();
  if (!token) throw new GitHubError("No GitHub token found (~/.pi-git-credentials or GITHUB_TOKEN)", 401);
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "pi-pr-extension",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new GitHubError(error instanceof Error ? error.message : String(error), 0);
  }
  const text = await response.text();
  const body = text ? safeJson(text) : null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message)
      : `GitHub returned ${response.status}`;
    throw new GitHubError(message, response.status);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface PullInfo {
  number: number;
  title?: string;
  html_url?: string;
  state?: string;
  merged?: boolean;
  head?: { ref?: string };
  base?: { ref?: string };
}

export async function findOpenPull(repo: string, branch: string): Promise<PullInfo | null> {
  const pulls = await request<PullInfo[]>(
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(branch)}&per_page=10`,
  ).catch(() => [] as PullInfo[]);
  const exact = pulls.find((pull) => pull.head?.ref === branch);
  if (exact) return exact;
  const open = await request<PullInfo[]>(`/repos/${repo}/pulls?state=open&per_page=100`).catch(() => [] as PullInfo[]);
  return open.find((pull) => pull.head?.ref === branch) ?? null;
}

/**
 * The pull request a branch has, whatever its state.
 *
 * A merged pull request means the work reached the base branch; a closed one
 * was a reviewer's decision. Either way the branch's work has a home, and
 * asking the agent for another pull request would only duplicate one a human
 * already handled. `findOpenPull` stays the one `ensurePull` uses, because a
 * closed pull request cannot be reused for new commits.
 *
 * Unlike `findOpenPull`, a failure here is thrown, not read as "no pull
 * request": a rate-limited or offline API is not evidence that a branch has no
 * pull request, and a caller that guesses puts the agent back to work on one.
 */
export async function findPullForBranch(repo: string, branch: string): Promise<PullInfo | null> {
  const pulls = await request<PullInfo[]>(
    `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(branch)}&per_page=30`,
  );
  const matching = pulls.filter((pull) => pull.head?.ref === branch);
  return matching.find((pull) => pull.state === "open")
    ?? matching.find((pull) => pull.merged)
    ?? matching[0]
    ?? null;
}

export async function createPull(
  repo: string,
  input: { title: string; head: string; base: string; body: string; draft?: boolean },
): Promise<PullInfo> {
  return request<PullInfo>(`/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ ...input, draft: Boolean(input.draft) }),
  });
}

export async function listOpenPulls(repo: string): Promise<PullInfo[]> {
  return request<PullInfo[]>(`/repos/${repo}/pulls?state=open&per_page=100`).catch(() => [] as PullInfo[]);
}

export async function mergePull(repo: string, number: number, method = "squash"): Promise<{ merged?: boolean; message?: string }> {
  return request(`/repos/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: method }),
  });
}
