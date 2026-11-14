import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, mkdir, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  closePull,
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


/* ---------------------------------------------------------------- deployments */

/** One environment's live state, read from the cluster. */
export interface DeploymentState {
  environment: string;
  namespace: string;
  webImage: string | null;
  apiImage: string | null;
  webReady: number;
  apiReady: number;
  updatedAt: string | null;
}

const ENVIRONMENTS = [
  { environment: "prod", namespace: "trykovo" },
  { environment: "staging", namespace: "trykovo-staging" },
] as const;

async function kubectlJson(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync("kubectl", args, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout || "{}");
}

/** Read both environments. Cluster-only: what is actually running, not what CI ran. */
export async function listDeployments(): Promise<DeploymentState[]> {
  const states: DeploymentState[] = [];
  for (const env of ENVIRONMENTS) {
    let deploy: { items?: Array<{
      metadata: { name: string };
      spec: { template: { spec: { containers: Array<{ image?: string }> } } };
      status?: { readyReplicas?: number; conditions?: Array<{ lastUpdateTime?: string }> };
    }> } = {};
    try {
      deploy = (await kubectlJson(["-n", env.namespace, "get", "deploy", "-o", "json"])) as typeof deploy;
    } catch {
      states.push({
        environment: env.environment, namespace: env.namespace,
        webImage: null, apiImage: null, webReady: 0, apiReady: 0, updatedAt: null,
      });
      continue;
    }
    const find = (name: string) => (deploy.items ?? []).find((d) => d.metadata.name === name);
    const web = find("phone-order-web");
    const api = find("phone-order-api");
    const stamp = [...(web?.status?.conditions ?? []), ...(api?.status?.conditions ?? [])]
      .map((c) => c.lastUpdateTime ?? "").filter(Boolean).sort().pop() ?? null;
    states.push({
      environment: env.environment,
      namespace: env.namespace,
      webImage: web?.spec?.template?.spec?.containers?.[0]?.image ?? null,
      apiImage: api?.spec?.template?.spec?.containers?.[0]?.image ?? null,
      webReady: web?.status?.readyReplicas ?? 0,
      apiReady: api?.status?.readyReplicas ?? 0,
      updatedAt: stamp,
    });
  }
  return states;
}

/* ------------------------------------------------------------ staging actions */

interface StagingRecord {
  repo: string;
  number: number;
  headRef: string;
  mergeSha: string;
  stagingBefore: string;
  at: string;
}

function recordPath(): string {
  return join(process.env.PI_WEB_DATA_DIR ?? "/tmp", "pr-staging-merges.json");
}
function recordKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}
async function readRecords(): Promise<Record<string, StagingRecord>> {
  try {
    return JSON.parse(await readFile(recordPath(), "utf8")) as Record<string, StagingRecord>;
  } catch {
    return {};
  }
}
async function writeRecords(records: Record<string, StagingRecord>): Promise<void> {
  await mkdir(dirname(recordPath()), { recursive: true });
  await writeFile(recordPath(), `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

async function repoRootOf(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

/** Merge a pull request's head commit into `staging` with a real merge commit. */
export async function mergePullRequestToStaging(options: {
  cwd: string; repo: string; number: number;
}): Promise<{ merged: boolean; mergeSha: string; stagingBefore: string }> {
  const repo = normalizeRepoSlug(options.repo);
  if (!repo) throw new PullRequestRequestError("repo must be owner/name", 400, "no-repo");
  const root = await repoRootOf(options.cwd);
  const pull = await getPull(repo, options.number);
  const head = String(pull.head?.sha ?? "");
  if (!head) throw new PullRequestRequestError("pull request has no head commit", 400, "not-found");

  await git(root, ["fetch", "--prune", "origin"]);
  const stagingBefore = (await git(root, ["rev-parse", "origin/staging"])).trim();

  const work = await mkdtemp(join(tmpdir(), "pr-staging-"));
  try {
    await git(root, ["worktree", "add", "--detach", work, "origin/staging"]);
    try {
      await git(work, ["merge", "--no-ff", "-m", `Merge ${repo}#${options.number} into staging`, head]);
    } catch (error) {
      try { await git(work, ["merge", "--abort"]); } catch { /* nothing in progress */ }
      throw new PullRequestRequestError(
        `Merge conflict; staging is untouched. ${error instanceof Error ? error.message.split("\n")[0] : ""}`,
        409, "not-found",
      );
    }
    const mergeSha = (await git(work, ["rev-parse", "HEAD"])).trim();
    await git(work, ["push", "origin", "HEAD:staging"]);
    const records = await readRecords();
    records[recordKey(repo, options.number)] = {
      repo, number: options.number, headRef: String(pull.head?.ref ?? ""),
      mergeSha, stagingBefore, at: new Date().toISOString(),
    };
    await writeRecords(records);
    return { merged: true, mergeSha, stagingBefore };
  } finally {
    try { await git(root, ["worktree", "remove", "--force", work]); } catch { /* already gone */ }
  }
}

/** Revert the staging merge commit for a pull request. */
export async function revertPullRequestFromStaging(options: {
  cwd: string; number: number; repo?: string;
}): Promise<{ reverted: boolean; sha: string }> {
  const records = await readRecords();
  const match = Object.values(records).find((r) => r.number === options.number
    && (!options.repo || r.repo === normalizeRepoSlug(options.repo)));
  if (!match) {
    throw new PullRequestRequestError(
      "No recorded staging merge for that pull request; nothing to revert", 404, "not-found",
    );
  }
  const root = await repoRootOf(options.cwd);
  await git(root, ["fetch", "--prune", "origin"]);
  const work = await mkdtemp(join(tmpdir(), "pr-revert-"));
  try {
    await git(root, ["worktree", "add", "--detach", work, "origin/staging"]);
    try {
      await git(work, ["revert", "-m", "1", "--no-edit", match.mergeSha]);
    } catch (error) {
      try { await git(work, ["revert", "--abort"]); } catch { /* nothing in progress */ }
      throw new PullRequestRequestError(
        `Revert conflict; staging is untouched. ${error instanceof Error ? error.message.split("\n")[0] : ""}`,
        409, "not-found",
      );
    }
    const sha = (await git(work, ["rev-parse", "HEAD"])).trim();
    await git(work, ["push", "origin", "HEAD:staging"]);
    return { reverted: true, sha };
  } finally {
    try { await git(root, ["worktree", "remove", "--force", work]); } catch { /* already gone */ }
  }
}

/** Close a pull request without merging it. */
export async function closePullRequest(options: { repo: string; number: number }): Promise<{ closed: boolean }> {
  const repo = normalizeRepoSlug(options.repo);
  if (!repo) throw new PullRequestRequestError("repo must be owner/name", 400, "no-repo");
  if (!hasGitHubToken()) throw new PullRequestRequestError("No GitHub token found", 400, "no-token");
  return closePull(repo, options.number);
}

/**
 * Merge one long-lived branch into another and publish it. Used by the
 * deployments tab to catch staging up to main, or promote staging to main.
 * A conflict aborts inside the throwaway worktree and leaves the remote branch
 * exactly as it was.
 */
export async function syncBranch(options: {
  cwd: string; from: string; to: string;
}): Promise<{ merged: boolean; sha: string; from: string; to: string }> {
  const from = options.from.trim();
  const to = options.to.trim();
  if (!from || !to) throw new PullRequestRequestError("from and to are required", 400, "not-found");
  if (from === to) throw new PullRequestRequestError("from and to must differ", 400, "not-found");
  const root = await repoRootOf(options.cwd);
  await git(root, ["fetch", "--prune", "origin"]);
  for (const ref of [from, to]) {
    try {
      await git(root, ["rev-parse", "--verify", "--quiet", `origin/${ref}`]);
    } catch {
      throw new PullRequestRequestError(`origin/${ref} does not exist`, 404, "not-found");
    }
  }
  const work = await mkdtemp(join(tmpdir(), "pr-sync-"));
  try {
    await git(root, ["worktree", "add", "--detach", work, `origin/${to}`]);
    try {
      await git(work, ["merge", "--no-ff", "-m", `Merge ${from} into ${to}`, `origin/${from}`]);
    } catch (error) {
      try { await git(work, ["merge", "--abort"]); } catch { /* nothing in progress */ }
      throw new PullRequestRequestError(
        `Merge conflict; ${to} is untouched. ${error instanceof Error ? error.message.split("\n")[0] : ""}`,
        409, "not-found",
      );
    }
    const sha = (await git(work, ["rev-parse", "HEAD"])).trim();
    await git(work, ["push", "origin", `HEAD:${to}`]);
    return { merged: true, sha, from, to };
  } finally {
    try { await git(root, ["worktree", "remove", "--force", work]); } catch { /* already gone */ }
  }
}
