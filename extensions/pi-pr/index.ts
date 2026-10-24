/**
 * pi-pr — keeps agent work from getting lost.
 *
 * Code changes get their own branch and pull request instead of piling up in
 * the default branch. The extension adds three tools (`pr_worktree`,
 * `pr_ship`, `pr_status`), blocks pushes to main, and nudges a run that is
 * about to settle with unshipped work.
 *
 * Two rules keep it from touching work it does not own:
 * - only paths the session touched, or that became dirty after the session
 *   started, are ever committed;
 * - shipping looks at the worktrees this session created, not just the
 *   checkout it was started in.
 *
 * The PR link is stored in the session as a `pi.pr` custom entry, so Pi Web can
 * list "the pull requests this chat opened" by reading the conversation itself.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as git from "./git";
import * as gh from "./github";

export const PULL_REQUEST_ENTRY_TYPE = "pi.pr";
export const WORKTREE_ENTRY_TYPE = "pi.pr.worktree";
export const PULL_REQUEST_GUARD_TYPE = "pi.pr.guard";
/** Two nudges per run: enough to fix a lapse, few enough to never loop. */
export const MAX_GUARD_NUDGES = 2;

export interface PullRequestLinkData {
  repo: string;
  number: number;
  url?: string;
  branch?: string;
  base?: string;
  title?: string;
  worktree?: string;
  createdAt: string;
}

export interface PendingShip {
  repo: string;
  branch: string;
  base?: string;
  worktree?: string;
  title?: string;
  createdAt: string;
}

export interface RecordedWorktree {
  branch: string;
  worktree: string;
  base?: string;
  title?: string;
  repo?: string;
}

export const WORK_PROTOCOL = `## Work preservation (pi-pr)

Work that is not pushed is work that can be lost. Every code change you make must leave a pushed branch with an open pull request:

- Never push to \`main\` or \`master\`. If a command would push there, run \`pr_ship\` instead.
- In a repository whose current branch is the default branch, do not edit files in place. Call \`pr_worktree\` first and make the change inside the worktree path it returns (use absolute paths, or \`cd\` inside the command).
- Before you report a coding task complete, call \`pr_ship\`. It commits, pushes, and opens or reuses the pull request for the work of this session, in this checkout or in a worktree it created. Report the pull request URL it returns.
- A question, an explanation, or a read-only investigation changes no files and needs no pull request. Never create one for those.
- If \`pr_ship\` cannot open the pull request (for example GitHub rejects it), say so and paste the error. Do not claim the work is safe.`;

const NUDGE_FOOTER = "Do not report the task complete until pr_ship returns a pull request URL.";

export interface ShipProgress {
  ok: boolean;
  text: string;
  link?: PullRequestLinkData;
  branch?: string;
  worktree?: string;
  pushed?: boolean;
}

export interface ShipOptions {
  title?: string;
  body?: string;
  commitMessage?: string;
  branch?: string;
  base?: string;
  draft?: boolean;
  /** Extra checkouts to ship from, for example worktrees this session created. */
  targets?: readonly { path: string; base?: string; title?: string }[];
  /** Repo-relative paths the session may commit. `null` means "everything". */
  allowedPaths?: readonly string[] | null;
  /** Test seam: the clock used for the recorded link. */
  now?: () => Date;
}

function defaultCommitMessage(dirtyPaths: readonly string[]): string {
  const preview = dirtyPaths.slice(0, 3).join(", ");
  const more = dirtyPaths.length > 3 ? ` +${dirtyPaths.length - 3}` : "";
  return preview ? `Update ${preview}${more}` : "Agent work";
}

function autoBody(repo: string, base: string, subjects: readonly string[], files: readonly string[]): string {
  const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join("\n");
  const sections = [
    subjects.length ? `## What changed\n\n${list(subjects)}` : "",
    files.length ? `## Files\n\n${list(files)}` : "",
    `---\nOpened by a Pi agent (\`pr_ship\`). Repository \`${repo}\`, base \`${base}\`.`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

interface TargetState {
  path: string;
  state: git.RepoState;
  /** Uncommitted paths this session may ship. */
  dirty: string[];
  ahead: number;
}

async function readTarget(
  path: string,
  options: { base?: string; allowedPaths?: readonly string[] | null },
): Promise<TargetState | null> {
  const state = await git.readRepoState(path, { base: options.base });
  if (!state) return null;
  // `allowedPaths` is computed against the checkout being inspected, so a
  // caller with several targets passes the list for the one it means.
  const dirty = git.scopedDirtyPaths(state.dirtyPaths, options.allowedPaths ?? null);
  return { path, state, dirty, ahead: state.ahead };
}

function hasWork(target: TargetState): boolean {
  return target.dirty.length > 0 || target.ahead > 0;
}

async function ensurePull(
  repoRoot: string,
  repo: string,
  branch: string,
  base: string,
  options: ShipOptions,
): Promise<gh.PullInfo> {
  const existing = await gh.findOpenPull(repo, branch).catch(() => null);
  if (existing) return existing;
  if (!(await git.branchPublished(repoRoot, branch))) {
    throw new Error(`origin/${branch} does not exist, so there is no branch to open a pull request for.`);
  }
  const subjects = await git.commitSubjects(repoRoot, base);
  const files = await git.changedFilesVsBase(repoRoot, base);
  return gh.createPull(repo, {
    title: options.title?.trim() || subjects[0] || branch,
    head: branch,
    base,
    body: options.body?.trim() || autoBody(repo, base, subjects, files),
    draft: options.draft,
  });
}

function linkFor(
  repo: string,
  pull: gh.PullInfo,
  meta: { branch: string; base: string; worktree?: string; title?: string },
  now: () => Date,
): PullRequestLinkData {
  return {
    repo,
    number: pull.number,
    url: pull.html_url ?? `https://github.com/${repo}/pull/${pull.number}`,
    branch: meta.branch,
    base: meta.base,
    title: pull.title ?? meta.title,
    worktree: meta.worktree,
    createdAt: now().toISOString(),
  };
}

/**
 * The whole "don't lose work" flow for one checkout: commit, push, open (or
 * reuse) the pull request. On the default branch the work is first moved
 * sideways into its own worktree and branch, so `main` stays clean and nothing
 * is rewritten.
 */
async function shipTarget(
  target: TargetState,
  repo: string,
  options: ShipOptions,
): Promise<ShipProgress> {
  const { state } = target;
  const base = options.base?.trim() || state.base;
  let workRoot = state.repoRoot;
  let branch = options.branch?.trim() || state.branch;
  let worktree: string | undefined = state.isWorktree ? state.repoRoot : undefined;
  let dirty = target.dirty;

  if (git.isProtectedBranch(state.branch, base)) {
    branch = options.branch?.trim() || git.branchFromTitle(options.title);
    worktree = await git.createWorktree(state.repoRoot, branch, base, "HEAD");
    workRoot = worktree;
    if (dirty.length) {
      const moved = await git.moveUncommittedWork(state.repoRoot, worktree, dirty);
      if (!moved) {
        throw new Error(
          `Could not move the uncommitted work from ${state.repoRoot} into ${worktree}. Nothing was lost: the changes are still in the checkout.`,
        );
      }
    }
    if (target.ahead > 0) {
      // The commits already exist on the new branch; put the default branch
      // back where origin has it so the next checkout starts clean.
      await git.resetBranchToRemote(state.repoRoot, base);
    }
    dirty = [];
  }

  const subject = options.commitMessage?.trim()
    || options.title?.trim()
    || defaultCommitMessage(dirty.length ? dirty : target.dirty);
  const sha = await git.commitAll(workRoot, subject, dirty.length ? dirty : []);
  await git.pushBranch(workRoot, branch);
  const pull = await ensurePull(workRoot, repo, branch, base, { ...options, title: options.title });
  const link = linkFor(repo, pull, { branch, base, worktree, title: options.title }, options.now ?? (() => new Date()));

  const notes = [
    `Shipped ${sha ? `${sha.slice(0, 7)} on ` : ""}${branch} → origin/${repo}.`,
    `Pull request #${pull.number}: ${link.url}`,
  ];
  if (worktree && !state.isWorktree) {
    notes.push(`The uncommitted work now lives in the worktree ${worktree}; the default branch is clean.`);
  }

  return { ok: true, text: notes.join("\n"), link, branch, worktree, pushed: true };
}

/**
 * Ship whatever this session has: this checkout, then any worktree it created.
 * Returns the first target that had something to publish, or an explanation.
 */
export async function shipWork(cwd: string, options: ShipOptions = {}): Promise<ShipProgress> {
  const primary = await readTarget(cwd, { base: options.base, allowedPaths: options.allowedPaths });
  if (!primary) return { ok: false, text: `Not a git repository: ${cwd}. Nothing to ship.` };

  const remote = gh.parseRepoRemote(primary.state.originUrl);
  if (!remote || remote.host !== "github.com") {
    return {
      ok: false,
      text: `The origin remote (${primary.state.originUrl ?? "none"}) is not a github.com repository, so no pull request can be opened. Commit and push the work yourself.`,
    };
  }
  const repo = remote.repo;
  await git.fetchOrigin(primary.state.repoRoot, primary.state.base);

  const candidates: TargetState[] = [];
  const reread = await readTarget(cwd, { base: options.base, allowedPaths: options.allowedPaths });
  if (reread) candidates.push(reread);
  for (const extra of options.targets ?? []) {
    if (!extra.path || extra.path === cwd || !existsSync(extra.path)) continue;
    const state = await readTarget(extra.path, { base: extra.base ?? options.base, allowedPaths: null });
    if (state) candidates.push(state);
  }

  // An explicitly named branch wins: the agent may have pushed it by hand.
  const requested = options.branch?.trim();
  if (requested && candidates.every((candidate) => candidate.state.branch !== requested)) {
    const base = options.base?.trim() || primary.state.base;
    try {
      const pull = await ensurePull(primary.state.repoRoot, repo, requested, base, options);
      const link = linkFor(repo, pull, { branch: requested, base, title: options.title }, options.now ?? (() => new Date()));
      return { ok: true, branch: requested, pushed: true, link, text: `Pull request #${pull.number} for ${requested}: ${link.url}` };
    } catch (error) {
      return {
        ok: false,
        text: `Branch ${requested} is not checked out here and no pull request could be opened for it: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const work = candidates.find(hasWork);
  if (work) {
    try {
      return await shipTarget(work, repo, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        branch: work.state.branch,
        pushed: false,
        text: `Could not ship ${work.state.branch}: ${message}`,
      };
    }
  }

  // Nothing to commit: the work may already be pushed, with no pull request yet.
  for (const candidate of candidates) {
    const { state } = candidate;
    if (git.isProtectedBranch(state.branch, state.base)) continue;
    if (!(await git.branchPublished(state.repoRoot, state.branch))) continue;
    try {
      const pull = await ensurePull(state.repoRoot, repo, state.branch, options.base?.trim() || state.base, options);
      const link = linkFor(
        repo,
        pull,
        { branch: state.branch, base: options.base?.trim() || state.base, worktree: state.isWorktree ? state.repoRoot : undefined, title: options.title },
        options.now ?? (() => new Date()),
      );
      return {
        ok: true,
        branch: state.branch,
        pushed: true,
        link,
        text: `Nothing new to commit; pull request #${pull.number} is open for ${state.branch}: ${link.url}`,
      };
    } catch {
      // Try the next checkout.
    }
  }

  return { ok: true, text: `Nothing to ship: ${primary.state.branch} is clean and level with origin/${primary.state.base}.` };
}

export interface WorktreeProgress {
  ok: boolean;
  text: string;
  path?: string;
  branch?: string;
}

/** Isolated checkout for a change that has not started yet. */
export async function startWorktree(
  cwd: string,
  options: { title?: string; base?: string; branch?: string } = {},
): Promise<WorktreeProgress> {
  const state = await git.readRepoState(cwd, { base: options.base });
  if (!state) return { ok: false, text: `Not a git repository: ${cwd}` };
  if (state.dirtyPaths.length) {
    return {
      ok: false,
      text: `${state.repoRoot} has ${state.dirtyPaths.length} uncommitted file(s). Call pr_ship first so that work is not mixed into the new change.`,
    };
  }
  const branch = options.branch?.trim() || git.branchFromTitle(options.title);
  const path = await git.createWorktree(state.repoRoot, branch, state.base);
  return {
    ok: true,
    path,
    branch,
    text: [
      `Worktree ready: ${path} (branch ${branch}, based on origin/${state.base}).`,
      `Make the change there with absolute paths, or prefix commands with \`cd ${path} && \`.`,
      "Call pr_ship when it is done; it commits, pushes and opens the pull request.",
    ].join("\n"),
  };
}

export interface WorkGap {
  needsShipping: boolean;
  reasons: string[];
  branch?: string;
  repoRoot?: string;
  base?: string;
}

export interface GapTarget {
  path: string;
  /** How the reason list refers to this checkout. */
  label?: string;
  base?: string;
  allowedPaths?: readonly string[] | null;
}

export interface GapOptions {
  /** Branches pushed earlier whose pull request never opened. */
  pending?: readonly PendingShip[];
  /** Worktrees this session created, inspected in addition to `cwd`. */
  targets?: readonly GapTarget[];
}

/**
 * What still separates this session's work from "pushed, with a pull request".
 * A session that changed nothing needs nothing, which is what keeps
 * question-and-answer runs out of the guard.
 */
export async function inspectionGap(cwd: string, options: GapOptions = {}): Promise<WorkGap> {
  const primaryTarget = (options.targets ?? []).find((target) => resolve(target.path) === resolve(cwd));
  const primary = await readTarget(cwd, { base: primaryTarget?.base, allowedPaths: primaryTarget?.allowedPaths ?? null });
  if (!primary) return { needsShipping: false, reasons: [] };

  const reasons: string[] = [];
  const check = async (target: GapTarget, isPrimary: boolean) => {
    const state = await readTarget(target.path, { base: target.base, allowedPaths: target.allowedPaths });
    if (!state) return;
    const where = isPrimary ? state.state.repoRoot : (target.label ?? state.state.repoRoot);
    if (state.dirty.length) {
      reasons.push(
        `${state.dirty.length} uncommitted file(s) in ${where}: ${state.dirty.slice(0, 5).join(", ")}${state.dirty.length > 5 ? ", …" : ""}`,
      );
    }
    if (state.ahead > 0) {
      reasons.push(`${state.ahead} commit(s) on ${state.state.branch} are not on origin/${state.state.base}`);
    }
    if (state.dirty.length || state.ahead > 0) return;
    if (git.isProtectedBranch(state.state.branch, state.state.base)) return;
    if (!(await git.branchPublished(state.state.repoRoot, state.state.branch))) return;
    const remote = gh.parseRepoRemote(state.state.originUrl);
    if (!remote || remote.host !== "github.com" || !gh.resolveToken()) return;
    const pull = await gh.findOpenPull(remote.repo, state.state.branch).catch(() => null);
    if (!pull) reasons.push(`branch ${state.state.branch} has no open pull request`);
  };

  await check(primaryTarget ?? { path: cwd }, true);
  for (const target of options.targets ?? []) {
    if (!target.path || resolve(target.path) === resolve(cwd) || !existsSync(target.path)) continue;
    await check(target, false);
  }

  for (const entry of options.pending ?? []) {
    reasons.push(`branch ${entry.branch} was pushed but its pull request was never opened`);
  }

  return {
    needsShipping: reasons.length > 0,
    reasons,
    branch: primary.state.branch,
    repoRoot: primary.state.repoRoot,
    base: primary.state.base,
  };
}

export function guardMessage(gap: WorkGap): string {
  const reasons = gap.reasons.map((reason) => `- ${reason}`).join("\n");
  return [
    "Work is not preserved yet:",
    reasons,
    "",
    "Call `pr_ship` now. It commits, pushes the branch, and opens (or reuses) the pull request, without pushing to the default branch.",
    NUDGE_FOOTER,
  ].join("\n");
}

/** `git push origin main` and friends must never run from an agent session. */
export function isPushToProtectedBranch(command: string): boolean {
  if (!/\bgit\b[^\n]*\bpush\b/.test(command)) return false;
  const afterPush = command.split(/\bpush\b/).slice(1).join(" push ");
  return /(?:^|[\s:])(?:main|master)(?:$|[\s;|&])/.test(afterPush);
}

/** Paths a write-like tool call names, so the session can be scoped to them. */
export function pathsFromToolCall(_toolName: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const keys = ["path", "file_path", "filePath", "target_path", "targetPath"];
  const paths: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) paths.push(value.trim());
  }
  const many = record.paths ?? record.files;
  if (Array.isArray(many)) {
    for (const value of many) {
      if (typeof value === "string" && value.trim()) paths.push(value.trim());
    }
  }
  return paths;
}

/**
 * What this chat recorded: opened pull requests, branches it pushed without
 * managing to open one, and the worktrees it created. All of it lives in the
 * session file, so a resumed chat still knows where its work is.
 */
export function recordedShips(ctx: ExtensionContext): {
  links: PullRequestLinkData[];
  pending: PendingShip[];
  worktrees: RecordedWorktree[];
} {
  const links: PullRequestLinkData[] = [];
  const pending: PendingShip[] = [];
  const worktrees: RecordedWorktree[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom") continue;
    if (entry.customType === WORKTREE_ENTRY_TYPE) {
      const data = (entry as { data?: unknown }).data;
      if (!data || typeof data !== "object") continue;
      const record = data as Record<string, unknown>;
      if (typeof record.branch !== "string" || typeof record.worktree !== "string") continue;
      worktrees.push({
        branch: record.branch,
        worktree: record.worktree,
        base: typeof record.base === "string" ? record.base : undefined,
        title: typeof record.title === "string" ? record.title : undefined,
        repo: typeof record.repo === "string" ? record.repo : undefined,
      });
      continue;
    }
    if (entry.customType !== PULL_REQUEST_ENTRY_TYPE) continue;
    const data = (entry as { data?: unknown }).data;
    const candidates = Array.isArray(data) ? data : [data];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const record = candidate as Record<string, unknown>;
      const number = typeof record.number === "number" ? record.number : Number(record.number);
      if (typeof record.repo !== "string" || !Number.isInteger(number)) continue;
      const branch = typeof record.branch === "string" ? record.branch : undefined;
      const createdAt = typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString();
      if (number <= 0) {
        if (branch) {
          pending.push({
            repo: record.repo,
            branch,
            base: typeof record.base === "string" ? record.base : undefined,
            worktree: typeof record.worktree === "string" ? record.worktree : undefined,
            title: typeof record.title === "string" ? record.title : undefined,
            createdAt,
          });
        }
        continue;
      }
      links.push({
        repo: record.repo,
        number,
        url: typeof record.url === "string" ? record.url : undefined,
        branch,
        base: typeof record.base === "string" ? record.base : undefined,
        title: typeof record.title === "string" ? record.title : undefined,
        worktree: typeof record.worktree === "string" ? record.worktree : undefined,
        createdAt,
      });
    }
  }
  const opened = new Set(links.map((link) => `${link.repo}:${link.branch ?? ""}`));
  return {
    links,
    // A branch that later got its pull request is no longer pending.
    pending: pending.filter((entry) => !opened.has(`${entry.repo}:${entry.branch}`)),
    worktrees,
  };
}

export interface SessionScope {
  /** Absolute paths this session wrote through a tool call. */
  touched: readonly string[];
  /** Repo-relative paths that were already dirty when the session started. */
  baseline: ReadonlySet<string> | null;
  baselineRoot: string | null;
}

/** Repo-relative paths the session is allowed to commit in one checkout. */
export function allowedPathsFor(
  scope: SessionScope,
  repoRoot: string,
  currentDirty: readonly string[],
): string[] | null {
  if (!scope.baseline || scope.baselineRoot !== repoRoot) return null;
  const allowed = new Set(git.repoRelativePaths(repoRoot, scope.touched));
  // A file that became dirty during the session belongs to the session.
  for (const path of currentDirty) {
    if (!scope.baseline.has(path)) allowed.add(path);
  }
  return [...allowed];
}

function statusTextForShips(ctx: ExtensionContext, ships: ReturnType<typeof recordedShips>): string[] {
  const lines: string[] = [];
  if (ships.links.length) {
    lines.push("Pull requests recorded in this session:");
    for (const link of ships.links) lines.push(`- #${link.number} ${link.title ?? ""} ${link.url ?? ""}`.trimEnd());
  } else {
    lines.push("Pull requests recorded in this session: none");
  }
  for (const entry of ships.pending) {
    lines.push(`Pushed without a pull request: ${entry.branch}${entry.worktree ? ` (worktree ${entry.worktree})` : ""}`);
  }
  for (const entry of ships.worktrees) {
    if (!existsSync(entry.worktree)) continue;
    lines.push(`Worktree of this session: ${entry.worktree} (branch ${entry.branch})`);
  }
  return lines;
}

async function statusText(ctx: ExtensionContext): Promise<string> {
  const state = await git.readRepoState(ctx.cwd);
  if (!state) return `Not a git repository: ${ctx.cwd}`;
  const lines = [
    `Repository: ${state.repoRoot}${state.isWorktree ? " (worktree)" : ""}`,
    `Branch: ${state.branch} (base origin/${state.base})`,
    `Uncommitted files: ${state.dirtyPaths.length}`,
    `Commits ahead of origin/${state.base}: ${state.ahead}`,
  ];
  return [...lines, ...statusTextForShips(ctx, recordedShips(ctx))].join("\n");
}

export default function piPrExtension(pi: ExtensionAPI) {
  const nudges = new Map<string, number>();
  const touched = new Map<string, string[]>();
  const baseline = new Map<string, { repoRoot: string; paths: Set<string> }>();

  const captureBaseline = async (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = await git.readRepoState(ctx.cwd).catch(() => null);
    if (!state) {
      baseline.delete(sessionId);
      return;
    }
    baseline.set(sessionId, { repoRoot: state.repoRoot, paths: new Set(state.dirtyPaths) });
  };

  const scopeFor = (ctx: ExtensionContext): SessionScope => {
    const sessionId = ctx.sessionManager.getSessionId();
    const entry = baseline.get(sessionId);
    return {
      touched: touched.get(sessionId) ?? [],
      baseline: entry?.paths ?? null,
      baselineRoot: entry?.repoRoot ?? null,
    };
  };

  pi.on("session_start", async (_event, ctx) => {
    nudges.clear();
    touched.clear();
    baseline.clear();
    await captureBaseline(ctx);
  });
  pi.on("agent_start", () => { nudges.clear(); });

  pi.on("before_agent_start", (event) => {
    // Appending to the rendered prompt keeps pi's structured sections intact
    // for the transcript while the model sees the protocol.
    if (event.systemPrompt.includes("## Work preservation (pi-pr)")) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${WORK_PROTOCOL}` };
  });

  pi.on("tool_call", (event, ctx) => {
    const writes = pathsFromToolCall(event.toolName, event.input);
    if (writes.length) {
      const sessionId = ctx.sessionManager.getSessionId();
      const known = new Set(touched.get(sessionId) ?? []);
      for (const path of writes) known.add(path);
      touched.set(sessionId, [...known]);
    }

    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const command = typeof (event.input as { command?: unknown }).command === "string"
      ? (event.input as { command: string }).command
      : "";
    if (!isPushToProtectedBranch(command)) return;
    return {
      block: true,
      reason: "Pushing directly to main/master is disabled by pi-pr. Use the pr_ship tool: it pushes a branch and opens a pull request.",
    };
  });

  pi.on("agent_before_settle", async (event, ctx): Promise<AgentBeforeSettleEventResult | undefined> => {
    if (event.outcome !== "completed") return;
    const sessionId = ctx.sessionManager.getSessionId();
    if ((nudges.get(sessionId) ?? 0) >= MAX_GUARD_NUDGES) return;

    const ships = recordedShips(ctx);
    const scope = scopeFor(ctx);
    const primary = await git.readRepoState(ctx.cwd).catch(() => null);
    const targets: GapTarget[] = ships.worktrees.map((entry) => ({
      path: entry.worktree,
      label: `${entry.worktree} (branch ${entry.branch})`,
      base: entry.base,
      // A worktree this session created starts clean, so all of its work is ours.
      allowedPaths: null,
    }));
    if (primary) {
      targets.unshift({
        path: ctx.cwd,
        base: undefined,
        allowedPaths: allowedPathsFor(scope, primary.repoRoot, primary.dirtyPaths),
      });
    }

    let gap: WorkGap;
    try {
      gap = await inspectionGap(ctx.cwd, { pending: ships.pending, targets });
    } catch {
      return;
    }
    if (!gap.needsShipping) return;

    nudges.set(sessionId, (nudges.get(sessionId) ?? 0) + 1);
    return {
      entries: [{
        type: "custom_message",
        customType: PULL_REQUEST_GUARD_TYPE,
        content: guardMessage(gap),
        display: true,
      }],
      continue: true,
    };
  });

  pi.registerTool({
    name: "pr_worktree",
    label: "Start isolated work",
    description: "Create a git worktree and branch for a change before editing files, so the default branch stays clean. Returns the absolute worktree path to work in.",
    promptSnippet: "pr_worktree: start a change in its own worktree and branch",
    promptGuidelines: [
      "Call pr_worktree before editing files in a repository checked out on main/master.",
      "Work inside the returned worktree path, then call pr_ship.",
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Short description of the change, used for the branch name." })),
      base: Type.Optional(Type.String({ description: "Base branch to branch from (default: the repository default branch)." })),
      branch: Type.Optional(Type.String({ description: "Exact branch name to create." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
      const result = await startWorktree(ctx.cwd, params);
      if (result.ok && result.path && result.branch) {
        const state = await git.readRepoState(ctx.cwd);
        pi.appendEntry(WORKTREE_ENTRY_TYPE, {
          repo: gh.parseRepoRemote(state?.originUrl ?? null)?.repo,
          branch: result.branch,
          worktree: result.path,
          base: state?.base,
          title: params.title,
          createdAt: new Date().toISOString(),
        });
      }
      return {
        content: [{ type: "text", text: result.text }],
        details: { path: result.path, branch: result.branch, ok: result.ok },
        ...(result.ok ? {} : { isError: true }),
      };
    },
  });

  pi.registerTool({
    name: "pr_ship",
    label: "Ship work as a pull request",
    description: "Commit the session's work, push it to a branch, and open (or reuse) a GitHub pull request. Looks at this checkout and at worktrees the session created; on the default branch it moves the work into its own worktree first. Returns the pull request URL.",
    promptSnippet: "pr_ship: commit, push and open the pull request for this work",
    promptGuidelines: [
      "Call pr_ship before reporting any coding task complete.",
      "Report the pull request URL that pr_ship returns.",
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Pull request title (default: the first commit subject)." })),
      body: Type.Optional(Type.String({ description: "Pull request description." })),
      commit_message: Type.Optional(Type.String({ description: "Commit message when the work is not committed yet." })),
      branch: Type.Optional(Type.String({ description: "Branch to create or to open the pull request for." })),
      base: Type.Optional(Type.String({ description: "Base branch for the pull request." })),
      draft: Type.Optional(Type.Boolean({ description: "Open the pull request as a draft." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
      const ships = recordedShips(ctx);
      const scope = scopeFor(ctx);
      const primary = await git.readRepoState(ctx.cwd).catch(() => null);
      const options: ShipOptions = {
        title: params.title,
        body: params.body,
        commitMessage: params.commit_message,
        branch: params.branch,
        base: params.base,
        draft: params.draft,
        targets: ships.worktrees
          .filter((entry) => existsSync(entry.worktree))
          .map((entry) => ({ path: entry.worktree, base: entry.base, title: entry.title })),
        allowedPaths: primary
          ? allowedPathsFor(scope, primary.repoRoot, primary.dirtyPaths)
          : null,
      };
      let result = await shipWork(ctx.cwd, options);

      // A previous attempt may have pushed a branch whose pull request never got
      // opened. Retry from that branch's worktree instead of starting over.
      if (!result.link) {
        for (const entry of ships.pending.slice().reverse()) {
          if (entry.worktree && existsSync(entry.worktree)) {
            const retry = await shipWork(entry.worktree, {
              ...options,
              title: options.title ?? entry.title,
              base: options.base ?? entry.base,
              branch: entry.branch,
              allowedPaths: null,
            });
            if (retry.link) {
              result = retry;
              break;
            }
          }
        }
      }

      if (result.link) pi.appendEntry(PULL_REQUEST_ENTRY_TYPE, result.link);
      else if (result.pushed && result.branch) {
        pi.appendEntry(PULL_REQUEST_ENTRY_TYPE, {
          repo: gh.parseRepoRemote((await git.readRepoState(ctx.cwd))?.originUrl ?? null)?.repo,
          number: 0,
          branch: result.branch,
          base: params.base,
          worktree: result.worktree,
          title: params.title,
          createdAt: new Date().toISOString(),
        });
      }

      return {
        content: [{ type: "text", text: result.text }],
        details: {
          ok: result.ok,
          link: result.link,
          branch: result.branch,
          worktree: result.worktree,
          pushed: result.pushed,
        },
        ...(result.ok ? {} : { isError: true }),
      };
    },
  });

  pi.registerTool({
    name: "pr_status",
    label: "Pull request status",
    description: "Show the repository, branch, uncommitted file count, unpushed commits, and the pull requests and worktrees recorded in this session.",
    promptSnippet: "pr_status: check whether this work is pushed with a pull request",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionToolContext) {
      const text = await statusText(ctx);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  pi.registerCommand("prs", {
    description: "Show branch, unshipped work and pull requests of this session",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const text = await statusText(ctx);
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("ship", {
    description: "Commit, push and open a pull request for the current work",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const result = await shipWork(ctx.cwd, { title: args.trim() || undefined });
      if (result.link) pi.appendEntry(PULL_REQUEST_ENTRY_TYPE, result.link);
      ctx.ui.notify(result.text, result.ok ? "info" : "error");
    },
  });
}
