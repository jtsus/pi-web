/** Client-safe types shared by the PR API routes and the panel. */

/** Which PRs the panel lists: the ones this chat produced, or every open PR of the project. */
export type PullRequestScope = "session" | "all";

/**
 * A pull request an agent opened for one chat. The agent's extension stores
 * these in the session file as `custom` entries with `customType` "pi.pr", so
 * the link travels with the conversation instead of a side database.
 */
export interface PullRequestLink {
  /** `owner/name` on github.com. */
  repo: string;
  number: number;
  url?: string;
  /** Head branch the agent pushed. */
  branch?: string;
  base?: string;
  title?: string;
  /** Worktree the work lives in, when the agent used one. */
  worktree?: string;
  createdAt?: string;
}

export type PullRequestState = "open" | "closed" | "merged";

export type PullRequestChecks = "passing" | "failing" | "pending" | "none";

export interface PullRequestSummary {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  draft: boolean;
  author: string | null;
  head: string;
  base: string;
  createdAt: string | null;
  updatedAt: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  checks: PullRequestChecks;
  /** GitHub's mergeable flag: null while GitHub is still computing it. */
  mergeable: boolean | null;
  /** True when this chat's agent recorded the PR. */
  fromSession: boolean;
  worktree?: string;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string | null;
  commits: number | null;
  comments: number | null;
  approvals: number;
  changesRequested: number;
  files: PullRequestFile[];
  /** A patch longer than the display cap is cut; the GitHub link has the rest. */
  filesTruncated: boolean;
}

export type PullRequestErrorCode = "no-repo" | "no-token" | "no-session" | "github" | "not-found";

export interface PullRequestError {
  code: PullRequestErrorCode;
  message: string;
}

export interface PullRequestListResponse {
  scope: PullRequestScope;
  sessionId: string | null;
  cwd: string | null;
  repo: string | null;
  prs: PullRequestSummary[];
  error?: PullRequestError;
}

export type PullRequestMergeMethod = "merge" | "squash" | "rebase";

export interface PullRequestMergeResponse {
  merged: boolean;
  message: string;
  sha?: string;
}

export const PULL_REQUEST_ENTRY_TYPE = "pi.pr";
export const PULL_REQUEST_MERGE_METHODS: readonly PullRequestMergeMethod[] = ["squash", "merge", "rebase"];
