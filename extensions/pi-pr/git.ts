import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;

export class GitFailure extends Error {
  readonly args: readonly string[];
  readonly stderr: string;
  constructor(args: readonly string[], stderr: string, message?: string) {
    super(message ?? (stderr.trim() || `git ${args.join(" ")} failed`));
    this.name = "GitFailure";
    this.args = args;
    this.stderr = stderr;
  }
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat" },
    });
    return stdout;
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr: unknown }).stderr)
      : "";
    throw new GitFailure(args, stderr, error instanceof Error ? error.message : String(error));
  }
}

export async function tryGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

export interface RepoState {
  repoRoot: string;
  /** True when repoRoot is a linked worktree rather than the main checkout. */
  isWorktree: boolean;
  branch: string;
  headSha: string;
  /** Default branch name, e.g. "main". */
  base: string;
  /** Commits on HEAD that origin/<base> does not have. */
  ahead: number;
  dirtyPaths: string[];
  originUrl: string | null;
}

export function parsePorcelainPaths(output: string): string[] {
  return output
    .split("\0")
    .map((record) => record.replace(/^..\s?/, "").trim())
    .filter(Boolean);
}

export async function repoRootFor(cwd: string): Promise<string | null> {
  const root = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  return root?.trim() || null;
}

async function resolveBaseBranch(repoRoot: string): Promise<string> {
  const symbolic = await tryGit(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const fromRemoteHead = symbolic?.trim().replace(/^origin\//, "");
  if (fromRemoteHead) return fromRemoteHead;
  for (const candidate of ["main", "master"]) {
    const exists = await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (exists !== null) return candidate;
  }
  for (const candidate of ["main", "master"]) {
    const exists = await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (exists !== null) return candidate;
  }
  return "main";
}

export async function readRepoState(cwd: string, options: { base?: string } = {}): Promise<RepoState | null> {
  const repoRoot = await repoRootFor(cwd);
  if (!repoRoot) return null;
  const gitDir = await tryGit(repoRoot, ["rev-parse", "--git-common-dir"]);
  const commonDir = gitDir?.trim();
  const isWorktree = Boolean(commonDir)
    && resolve(repoRoot, commonDir as string) !== resolve(repoRoot, ".git");

  const branch = (await tryGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() || "HEAD";
  const headSha = (await tryGit(repoRoot, ["rev-parse", "HEAD"]))?.trim() || "";
  const base = options.base?.trim() || await resolveBaseBranch(repoRoot);
  const status = (await tryGit(repoRoot, ["status", "--porcelain=v1", "-z"])) ?? "";
  const dirtyPaths = parsePorcelainPaths(status);
  const aheadRaw = (await tryGit(repoRoot, ["rev-list", "--count", `refs/remotes/origin/${base}..HEAD`]))
    ?? (await tryGit(repoRoot, ["rev-list", "--count", `refs/heads/${base}..HEAD`]));
  const ahead = Number.parseInt((aheadRaw ?? "0").trim(), 10) || 0;
  const originUrl = (await tryGit(repoRoot, ["remote", "get-url", "origin"]))?.trim() || null;

  return { repoRoot, isWorktree, branch, headSha, base, ahead, dirtyPaths, originUrl };
}

/** `agent/fix-login-page-a3f2` — short, lowercase, no punctuation git dislikes. */
export function branchFromTitle(title: string | undefined, suffix: string = Date.now().toString(36).slice(-4)): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 48);
  const clean = suffix.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8);
  const tail = clean || Math.random().toString(36).slice(2, 6);
  return `agent/${slug || "work"}-${tail}`;
}

export function isProtectedBranch(branch: string, base: string): boolean {
  return branch === base || branch === "main" || branch === "master" || branch === "HEAD";
}

export function worktreePathFor(repoRoot: string, branch: string): string {
  const dirName = branch.replace(/[/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "work";
  return join(`${resolve(repoRoot)}-worktrees`, dirName);
}

export async function fetchOrigin(repoRoot: string, base: string): Promise<void> {
  // Best effort: an offline ship still commits and pushes from local refs.
  await tryGit(repoRoot, ["fetch", "--quiet", "--no-tags", "origin", base]);
  await tryGit(repoRoot, ["fetch", "--quiet", "--no-tags", "origin"]);
}

export async function createWorktree(
  repoRoot: string,
  branch: string,
  base: string,
  /** Commit the new branch starts at; defaults to the remote tip of `base`. */
  startPoint = `refs/remotes/origin/${base}`,
): Promise<string> {
  const worktreePath = worktreePathFor(repoRoot, branch);
  if (existsSync(worktreePath)) {
    const existing = await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (existing !== null) return worktreePath;
    throw new Error(`Worktree directory already exists without branch ${branch}: ${worktreePath}`);
  }
  mkdirSync(dirname(worktreePath), { recursive: true });
  const resolvedStart = (await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", startPoint])) !== null
    ? startPoint
    : "HEAD";
  const branchExists = (await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !== null;
  if (branchExists) {
    await runGit(repoRoot, ["worktree", "add", "--", worktreePath, branch], NETWORK_TIMEOUT_MS);
  } else {
    await runGit(repoRoot, ["worktree", "add", "-b", branch, "--", worktreePath, resolvedStart], NETWORK_TIMEOUT_MS);
  }
  return worktreePath;
}

/**
 * Move the checkout's uncommitted work into `worktreePath`.
 *
 * `git stash` is repository-wide, so the changes can be stashed in the main
 * checkout and applied in the worktree, leaving the main checkout clean while
 * nothing is lost. Untracked files travel too (`-u`).
 */
export async function moveUncommittedWork(repoRoot: string, worktreePath: string): Promise<boolean> {
  const stashed = await tryGit(repoRoot, ["stash", "push", "-u", "-m", "pi-pr ship"]);
  if (stashed === null) return false;
  const applied = await tryGit(worktreePath, ["stash", "apply"]);
  if (applied === null) {
    // Put it back where it came from rather than stranding the work in the stash.
    await tryGit(repoRoot, ["stash", "pop"]);
    return false;
  }
  await tryGit(repoRoot, ["stash", "drop"]);
  return true;
}

export async function commitAll(repoRoot: string, message: string): Promise<string | null> {
  const staged = (await tryGit(repoRoot, ["status", "--porcelain=v1"]))?.trim();
  if (!staged) return null;
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["commit", "--no-verify", "-m", message]);
  const sha = (await tryGit(repoRoot, ["rev-parse", "HEAD"]))?.trim();
  return sha || null;
}

export async function pushBranch(repoRoot: string, branch: string): Promise<void> {
  await runGit(repoRoot, ["push", "--set-upstream", "origin", branch], NETWORK_TIMEOUT_MS);
}

export async function resetBranchToRemote(repoRoot: string, branch: string): Promise<void> {
  await runGit(repoRoot, ["reset", "--hard", `refs/remotes/origin/${branch}`]);
}

export async function commitSubjects(repoRoot: string, base: string, limit = 20): Promise<string[]> {
  const range = (await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`])) !== null
    ? `refs/remotes/origin/${base}..HEAD`
    : `refs/heads/${base}..HEAD`;
  const log = await tryGit(repoRoot, ["log", `--max-count=${limit}`, "--format=%s", range]);
  return (log ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function changedFilesVsBase(repoRoot: string, base: string, limit = 40): Promise<string[]> {
  const ref = (await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`])) !== null
    ? `refs/remotes/origin/${base}`
    : `refs/heads/${base}`;
  const diff = await tryGit(repoRoot, ["diff", "--name-only", `${ref}...HEAD`]);
  return (diff ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, limit);
}
