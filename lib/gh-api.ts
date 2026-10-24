import { parseGitHubRemote } from "./git-remote";
import { resolveGitHubToken } from "./gh-token";
import {
  PULL_REQUEST_MERGE_METHODS,
  type PullRequestChecks,
  type PullRequestDetail,
  type PullRequestFile,
  type PullRequestLink,
  type PullRequestMergeMethod,
  type PullRequestSummary,
} from "./pr-types";
import { combineChecks, pullRequestState } from "./pr-view";

const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 20_000;
const FILE_PATCH_MAX_CHARS = 12_000;
const MAP_CACHE_TTL_MS = 20_000;

export class GitHubApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

declare global {
  var __piPrCache: Map<string, { value: unknown; expiresAt: number }> | undefined;
}

function cache(): Map<string, { value: unknown; expiresAt: number }> {
  globalThis.__piPrCache ??= new Map();
  return globalThis.__piPrCache;
}

function readCache<T>(key: string): T | undefined {
  const hit = cache().get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache().delete(key);
    return undefined;
  }
  return hit.value as T;
}

function writeCache(key: string, value: unknown, ttlMs = MAP_CACHE_TTL_MS): void {
  const store = cache();
  // The panel polls; keep the map from growing without bound in a long-lived server.
  if (store.size > 200) store.clear();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function hasGitHubToken(): boolean {
  return resolveGitHubToken() !== null;
}

async function githubRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const credential = resolveGitHubToken();
  if (!credential) throw new GitHubApiError("No GitHub token found", 401);

  const method = init.method ?? "GET";
  const cacheKey = method === "GET" ? `GET ${path}` : null;
  if (cacheKey) {
    const hit = readCache<T>(cacheKey);
    if (hit !== undefined) return hit;
  }

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      ...init,
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${credential.token}`,
        "User-Agent": "pi-web-pull-requests",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GitHubApiError(error instanceof Error ? error.message : String(error), 0);
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message)
      : `GitHub returned ${response.status}`;
    throw new GitHubApiError(message, response.status);
  }

  if (cacheKey) writeCache(cacheKey, body);
  return body as T;
}

interface RawPull {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  merged?: boolean;
  draft?: boolean;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  commits?: number;
  comments?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  mergeable?: boolean | null;
  user?: { login?: string };
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string };
}

function repoFromPull(repo: string, pull: RawPull): string {
  const fullName = pull.head?.repo?.full_name;
  if (fullName && parseGitHubRemote(`https://github.com/${fullName}`)) return fullName;
  return repo;
}

function mapSummary(
  repo: string,
  pull: RawPull,
  checks: PullRequestChecks,
  link?: PullRequestLink,
): PullRequestSummary {
  return {
    repo: repoFromPull(repo, pull),
    number: pull.number,
    title: pull.title?.trim() || `#${pull.number}`,
    url: pull.html_url ?? `https://github.com/${repo}/pull/${pull.number}`,
    state: pullRequestState(pull.state ?? "open", Boolean(pull.merged)),
    draft: Boolean(pull.draft),
    author: pull.user?.login ?? null,
    head: pull.head?.ref ?? "",
    base: pull.base?.ref ?? "",
    createdAt: pull.created_at ?? null,
    updatedAt: pull.updated_at ?? pull.created_at ?? null,
    additions: typeof pull.additions === "number" ? pull.additions : null,
    deletions: typeof pull.deletions === "number" ? pull.deletions : null,
    changedFiles: typeof pull.changed_files === "number" ? pull.changed_files : null,
    checks,
    mergeable: typeof pull.mergeable === "boolean" ? pull.mergeable : null,
    fromSession: Boolean(link),
    worktree: link?.worktree,
  };
}

interface RawCheckRuns {
  total_count?: number;
  check_runs?: { status?: string; conclusion?: string | null }[];
}

interface RawCombinedStatus {
  state?: string;
  total_count?: number;
}

/** Worst-first rollup of check runs plus legacy commit statuses. */
export async function checksForSha(repo: string, sha: string | undefined): Promise<PullRequestChecks> {
  if (!sha) return "none";
  const states: PullRequestChecks[] = [];

  try {
    const runs = await githubRequest<RawCheckRuns>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    const conclusions = (runs.check_runs ?? []).map((run) => {
      if (run.status !== "completed") return "pending" as const;
      const conclusion = run.conclusion ?? "";
      if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") return "passing" as const;
      return "failing" as const;
    });
    if (conclusions.length) states.push(combineChecks(conclusions));
  } catch {
    // Checks need extra scopes and are absent on many repos: not an error here.
  }

  try {
    const status = await githubRequest<RawCombinedStatus>(`/repos/${repo}/commits/${sha}/status`);
    // A repository without CI returns "pending" with zero statuses; that is not
    // a running check, so it must not paint the row yellow.
    if (!status.total_count) return combineChecks(states);
    if (status.state === "success") states.push("passing");
    else if (status.state === "pending") states.push("pending");
    else if (status.state === "failure" || status.state === "error") states.push("failing");
  } catch {
    // Same as above.
  }

  return combineChecks(states);
}

export async function listOpenPulls(repo: string): Promise<RawPull[]> {
  return githubRequest<RawPull[]>(`/repos/${repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`);
}

export async function getPull(repo: string, number: number): Promise<RawPull> {
  return githubRequest<RawPull>(`/repos/${repo}/pulls/${number}`);
}

/** Open pull whose head branch is `branch`, so shipping twice does not stack PRs. */
export async function findOpenPullForBranch(
  repo: string,
  branch: string,
  owner?: string,
): Promise<RawPull | null> {
  const head = owner ? `${owner}:${branch}` : branch;
  try {
    const pulls = await githubRequest<RawPull[]>(
      `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(head)}&per_page=10`,
    );
    return pulls.find((pull) => pull.head?.ref === branch) ?? null;
  } catch {
    const open = await listOpenPulls(repo).catch(() => [] as RawPull[]);
    return open.find((pull) => pull.head?.ref === branch) ?? null;
  }
}

export function summarizeRawPull(
  repo: string,
  pull: RawPull,
  checks: PullRequestChecks,
  link?: PullRequestLink,
): PullRequestSummary {
  return mapSummary(repo, pull, checks, link);
}

export async function summarizePulls(
  repo: string,
  pulls: readonly RawPull[],
  links: readonly PullRequestLink[],
): Promise<PullRequestSummary[]> {
  const key = (candidate: RawPull) => `${repo}#${candidate.number}`.toLowerCase();
  const linkByKey = new Map(links.map((link) => [`${link.repo}#${link.number}`.toLowerCase(), link]));
  const summaries = await Promise.all(pulls.map(async (pull) => {
    const checks = await checksForSha(repo, pull.head?.sha);
    return mapSummary(repo, pull, checks, linkByKey.get(key(pull)));
  }));
  return summaries;
}

interface RawFile {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

interface RawReview {
  state?: string;
  user?: { login?: string } | null;
}

export async function getPullDetail(
  repo: string,
  number: number,
  link?: PullRequestLink,
): Promise<PullRequestDetail> {
  const pull = await getPull(repo, number);
  const filesKey = `files ${repo}#${number}`;
  let rawFiles = readCache<RawFile[]>(filesKey);
  if (!rawFiles) {
    rawFiles = await githubRequest<RawFile[]>(`/repos/${repo}/pulls/${number}/files?per_page=100`);
    writeCache(filesKey, rawFiles, 60_000);
  }

  let approvals = 0;
  let changesRequested = 0;
  try {
    const reviews = await githubRequest<RawReview[]>(`/repos/${repo}/pulls/${number}/reviews?per_page=100`);
    // Only the latest review per author decides that author's stance; the list
    // is chronological, so later entries overwrite earlier ones.
    const latest = new Map<string, string>();
    for (const review of reviews) {
      const state = review.state ?? "";
      if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") continue;
      latest.set(review.user?.login ?? `anonymous-${latest.size}`, state);
    }
    approvals = [...latest.values()].filter((state) => state === "APPROVED").length;
    changesRequested = [...latest.values()].filter((state) => state === "CHANGES_REQUESTED").length;
  } catch {
    // Reviews are advisory here; a missing scope must not hide the PR.
  }

  let filesTruncated = false;
  const files: PullRequestFile[] = (rawFiles ?? []).map((file) => {
    let patch = file.patch;
    if (patch && patch.length > FILE_PATCH_MAX_CHARS) {
      patch = `${patch.slice(0, FILE_PATCH_MAX_CHARS)}\n… diff truncated`;
      filesTruncated = true;
    }
    return {
      filename: file.filename ?? "(unknown)",
      status: file.status ?? "modified",
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      patch,
    };
  });

  const checks = await checksForSha(repo, pull.head?.sha);
  const summary = mapSummary(repo, pull, checks, link);
  return {
    ...summary,
    body: pull.body ?? null,
    commits: typeof pull.commits === "number" ? pull.commits : null,
    comments: typeof pull.comments === "number" ? pull.comments : null,
    approvals,
    changesRequested,
    files,
    filesTruncated,
  };
}

export interface MergePullResult {
  merged: boolean;
  message: string;
  sha?: string;
}

export async function mergePull(
  repo: string,
  number: number,
  method: PullRequestMergeMethod = "squash",
): Promise<MergePullResult> {
  const safeMethod = PULL_REQUEST_MERGE_METHODS.includes(method) ? method : "squash";
  const result = await githubRequest<{ merged?: boolean; message?: string; sha?: string }>(
    `/repos/${repo}/pulls/${number}/merge`,
    { method: "PUT", body: JSON.stringify({ merge_method: safeMethod }) },
  );
  cache().clear();
  return {
    merged: Boolean(result.merged),
    message: result.message?.trim() || (result.merged ? "Merged" : "Not merged"),
    sha: result.sha,
  };
}

export interface CreatePullRequestInput {
  title: string;
  head: string;
  base: string;
  body: string;
  draft?: boolean;
}

export async function createPull(repo: string, input: CreatePullRequestInput): Promise<RawPull> {
  const pull = await githubRequest<RawPull>(`/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: Boolean(input.draft),
    }),
  });
  cache().clear();
  return pull;
}

export type { RawPull };
