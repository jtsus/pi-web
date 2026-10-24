/**
 * pi-pr — keeps agent work from getting lost.
 *
 * Code changes get their own branch and pull request instead of piling up in
 * the default branch. The extension adds three tools (`pr_worktree`,
 * `pr_ship`, `pr_status`), blocks pushes to main, and nudges a run that is
 * about to settle with unshipped work.
 *
 * The PR link is stored in the session as a `pi.pr` custom entry, so Pi Web can
 * list "the pull requests this chat opened" by reading the conversation itself.
 */
import { existsSync } from "node:fs";
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

export const WORK_PROTOCOL = `## Work preservation (pi-pr)

Work that is not pushed is work that can be lost. Every code change you make must leave a pushed branch with an open pull request:

- Never push to \`main\` or \`master\`. If a command would push there, run \`pr_ship\` instead.
- In a repository whose current branch is the default branch, do not edit files in place. Call \`pr_worktree\` first and make the change inside the worktree path it returns (use absolute paths, or \`cd\` inside the command).
- Before you report a coding task complete, call \`pr_ship\`. It commits the work, pushes the branch, and opens or reuses the pull request. Report the pull request URL it returns.
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
  /** Test seam: the clock used for the recorded link. */
  now?: () => Date;
}

function defaultCommitMessage(state: git.RepoState): string {
  const preview = state.dirtyPaths.slice(0, 3).join(", ");
  const more = state.dirtyPaths.length > 3 ? ` +${state.dirtyPaths.length - 3}` : "";
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

/**
 * The whole "don't lose work" flow: commit, push, open (or reuse) the pull
 * request. On the default branch the work is first moved sideways into its own
 * worktree and branch, so `main` stays clean and nothing is rewritten.
 */
export async function shipWork(cwd: string, options: ShipOptions = {}): Promise<ShipProgress> {
  const initial = await git.readRepoState(cwd, { base: options.base });
  if (!initial) return { ok: false, text: `Not a git repository: ${cwd}. Nothing to ship.` };

  const remote = gh.parseRepoRemote(initial.originUrl);
  if (!remote || remote.host !== "github.com") {
    return {
      ok: false,
      text: `The origin remote (${initial.originUrl ?? "none"}) is not a github.com repository, so no pull request can be opened. Commit and push the work yourself.`,
    };
  }

  await git.fetchOrigin(initial.repoRoot, initial.base);
  const state = (await git.readRepoState(cwd, { base: options.base })) ?? initial;
  const base = state.base;
  const repo = remote.repo;

  const hasChanges = state.dirtyPaths.length > 0 || state.ahead > 0;
  const existing = await gh.findOpenPull(repo, state.branch).catch(() => null);

  if (!hasChanges) {
    if (existing) {
      return {
        ok: true,
        text: `Nothing new to ship. #${existing.number} is already open for ${state.branch}: ${existing.html_url ?? ""}`,
        branch: state.branch,
        pushed: true,
      };
    }
    if (git.isProtectedBranch(state.branch, base)) {
      return { ok: true, text: `Nothing to ship: ${state.branch} is clean and level with origin/${base}.` };
    }
    // The branch exists with nothing ahead of base: still worth a PR when it
    // differs, otherwise there is genuinely nothing to publish.
    const diff = await git.changedFilesVsBase(state.repoRoot, base);
    if (!diff.length) {
      return { ok: true, text: `Nothing to ship: ${state.branch} has no changes against origin/${base}.` };
    }
  }

  let workRoot = state.repoRoot;
  let branch = state.branch;
  let worktree: string | undefined;

  if (git.isProtectedBranch(state.branch, base)) {
    branch = options.branch?.trim() || git.branchFromTitle(options.title);
    worktree = await git.createWorktree(state.repoRoot, branch, base, "HEAD");
    workRoot = worktree;
    if (state.dirtyPaths.length) {
      const moved = await git.moveUncommittedWork(state.repoRoot, worktree);
      if (!moved) {
        throw new Error(
          `Could not move the uncommitted work from ${state.repoRoot} into ${worktree}. Nothing was lost: the changes are still in the checkout.`,
        );
      }
    }
    if (state.ahead > 0) {
      // The commits already exist on the new branch; put the default branch
      // back where origin has it so the next checkout starts clean.
      await git.resetBranchToRemote(state.repoRoot, base);
    }
  }

  const subject = options.commitMessage?.trim() || options.title?.trim() || defaultCommitMessage(state);
  const sha = await git.commitAll(workRoot, subject);
  await git.pushBranch(workRoot, branch);

  let pull = existing;
  if (!pull) {
    const subjects = await git.commitSubjects(workRoot, base);
    const files = await git.changedFilesVsBase(workRoot, base);
    try {
      pull = await gh.createPull(repo, {
        title: options.title?.trim() || subjects[0] || subject || branch,
        head: branch,
        base,
        body: options.body?.trim() || autoBody(repo, base, subjects, files),
        draft: options.draft,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        branch,
        worktree,
        pushed: true,
        text: `Pushed ${branch} to origin/${repo}, but opening the pull request failed: ${message}\nThe commits are safe on the remote branch. Retry with pr_ship.`,
      };
    }
  }

  const link: PullRequestLinkData = {
    repo,
    number: pull.number,
    url: pull.html_url ?? `https://github.com/${repo}/pull/${pull.number}`,
    branch,
    base,
    title: pull.title ?? options.title,
    worktree,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
  };

  const notes = [
    `Shipped ${sha ? `${sha.slice(0, 7)} on ` : ""}${branch} → origin/${repo}.`,
    `Pull request #${pull.number}: ${link.url}`,
  ];
  if (worktree) notes.push(`The uncommitted work now lives in the worktree ${worktree}; the default branch is clean.`);
  if (pull.state && pull.state !== "open") notes.push(`GitHub reports the pull request as ${pull.state}.`);

  return { ok: true, text: notes.join("\n"), link, branch, worktree, pushed: true };
}

export interface WorktreeProgress {
  ok: boolean;
  text: string;
  path?: string;
  branch?: string;
}

/** Isolated checkout for a change that has not started yet. */
export async function startWorktree(cwd: string, options: { title?: string; base?: string; branch?: string } = {}): Promise<WorktreeProgress> {
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

/**
 * What still separates this checkout from "pushed, with a pull request".
 * A clean checkout on the default branch needs nothing, which is what keeps
 * question-and-answer sessions out of the guard.
 */
export async function inspectionGap(
  cwd: string,
  options: { pending?: readonly PendingShip[] } = {},
): Promise<WorkGap> {
  const state = await git.readRepoState(cwd);
  if (!state) return { needsShipping: false, reasons: [] };

  const reasons: string[] = [];
  if (state.dirtyPaths.length) {
    reasons.push(`${state.dirtyPaths.length} uncommitted file(s) in ${state.repoRoot}: ${state.dirtyPaths.slice(0, 5).join(", ")}${state.dirtyPaths.length > 5 ? ", …" : ""}`);
  }
  if (state.ahead > 0) {
    reasons.push(`${state.ahead} commit(s) on ${state.branch} are not on origin/${state.base}`);
  }

  if (!reasons.length && !git.isProtectedBranch(state.branch, state.base)) {
    const remote = gh.parseRepoRemote(state.originUrl);
    if (remote && remote.host === "github.com" && gh.resolveToken()) {
      const pull = await gh.findOpenPull(remote.repo, state.branch).catch(() => null);
      if (!pull) reasons.push(`branch ${state.branch} has no open pull request`);
    }
  }

  for (const entry of options.pending ?? []) {
    reasons.push(`branch ${entry.branch} was pushed but its pull request was never opened`);
  }

  return {
    needsShipping: reasons.length > 0,
    reasons,
    branch: state.branch,
    repoRoot: state.repoRoot,
    base: state.base,
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

export interface PendingShip {
  repo: string;
  branch: string;
  base?: string;
  worktree?: string;
  title?: string;
  createdAt: string;
}

/**
 * What this chat recorded: opened pull requests, plus branches it pushed without
 * managing to open one (so a retry knows where the work is).
 */
export function recordedShips(ctx: ExtensionContext): { links: PullRequestLinkData[]; pending: PendingShip[] } {
  const links: PullRequestLinkData[] = [];
  const pending: PendingShip[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== PULL_REQUEST_ENTRY_TYPE) continue;
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
  // A branch that later got its pull request is no longer pending.
  const opened = new Set(links.map((link) => `${link.repo}:${link.branch ?? ""}`));
  return {
    links,
    pending: pending.filter((entry) => !opened.has(`${entry.repo}:${entry.branch}`)),
  };
}

async function statusText(ctx: ExtensionContext): Promise<string> {
  const state = await git.readRepoState(ctx.cwd);
  if (!state) return `Not a git repository: ${ctx.cwd}`;
  const { links, pending } = recordedShips(ctx);
  const lines = [
    `Repository: ${state.repoRoot}${state.isWorktree ? " (worktree)" : ""}`,
    `Branch: ${state.branch} (base origin/${state.base})`,
    `Uncommitted files: ${state.dirtyPaths.length}`,
    `Commits ahead of origin/${state.base}: ${state.ahead}`,
  ];
  if (links.length) {
    lines.push("Pull requests recorded in this session:");
    for (const link of links) lines.push(`- #${link.number} ${link.title ?? ""} ${link.url ?? ""}`.trimEnd());
  } else {
    lines.push("Pull requests recorded in this session: none");
  }
  for (const entry of pending) {
    lines.push(`Pushed without a pull request: ${entry.branch}${entry.worktree ? ` (worktree ${entry.worktree})` : ""}`);
  }
  return lines.join("\n");
}

export default function piPrExtension(pi: ExtensionAPI) {
  const nudges = new Map<string, number>();

  pi.on("session_start", () => { nudges.clear(); });
  pi.on("agent_start", () => { nudges.clear(); });

  pi.on("before_agent_start", (event) => {
    // Appending to the rendered prompt keeps pi's structured sections intact
    // for the transcript while the model sees the protocol.
    if (event.systemPrompt.includes("## Work preservation (pi-pr)")) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${WORK_PROTOCOL}` };
  });

  pi.on("tool_call", (event) => {
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
    let gap: WorkGap;
    try {
      gap = await inspectionGap(ctx.cwd, { pending: recordedShips(ctx).pending });
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
    description: "Commit the current work, push it to a branch, and open (or reuse) a GitHub pull request. On the default branch the work is moved into its own worktree first. Returns the pull request URL.",
    promptSnippet: "pr_ship: commit, push and open the pull request for this work",
    promptGuidelines: [
      "Call pr_ship before reporting any coding task complete.",
      "Report the pull request URL that pr_ship returns.",
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Pull request title (default: the first commit subject)." })),
      body: Type.Optional(Type.String({ description: "Pull request description." })),
      commit_message: Type.Optional(Type.String({ description: "Commit message when the work is not committed yet." })),
      branch: Type.Optional(Type.String({ description: "Branch to create when the work starts on the default branch." })),
      base: Type.Optional(Type.String({ description: "Base branch for the pull request." })),
      draft: Type.Optional(Type.Boolean({ description: "Open the pull request as a draft." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
      const options: ShipOptions = {
        title: params.title,
        body: params.body,
        commitMessage: params.commit_message,
        branch: params.branch,
        base: params.base,
        draft: params.draft,
      };
      let result = await shipWork(ctx.cwd, options);

      // A previous attempt may have pushed a branch whose pull request never got
      // opened. Retry from that branch's worktree instead of starting over.
      if (!result.link) {
        const { pending } = recordedShips(ctx);
        for (const entry of pending.slice().reverse()) {
          if (entry.worktree && existsSync(entry.worktree)) {
            const retry = await shipWork(entry.worktree, { ...options, title: options.title ?? entry.title, base: options.base ?? entry.base });
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
    description: "Show the repository, branch, uncommitted file count, unpushed commits, and the pull requests recorded in this session.",
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
