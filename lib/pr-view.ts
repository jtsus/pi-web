import type {
  PullRequestChecks,
  PullRequestScope,
  PullRequestState,
  PullRequestSummary,
} from "./pr-types";

export const PR_SCOPE_STORAGE_KEY = "pi-pr-scope";
export const PR_SCOPE_AUTO_REFRESH_MS = 30_000;

export function parsePullRequestScope(value: string | null | undefined): PullRequestScope | null {
  return value === "session" || value === "all" ? value : null;
}

/** GitHub reports three states; the panel hides everything that is not open. */
export function pullRequestState(raw: string, merged: boolean): PullRequestState {
  if (merged) return "merged";
  return raw === "open" ? "open" : "closed";
}

export function isVisiblePullRequest(pr: Pick<PullRequestSummary, "state">): boolean {
  return pr.state === "open";
}

export function sortPullRequests(prs: readonly PullRequestSummary[]): PullRequestSummary[] {
  return [...prs].sort((a, b) => {
    if (a.fromSession !== b.fromSession) return a.fromSession ? -1 : 1;
    return timestamp(b.updatedAt) - timestamp(a.updatedAt) || a.number - b.number;
  });
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Worst-first: one failing run makes the whole PR failing. */
export function combineChecks(
  states: readonly (PullRequestChecks | null | undefined)[],
): PullRequestChecks {
  let seen = false;
  let pending = false;
  for (const state of states) {
    if (!state || state === "none") continue;
    seen = true;
    if (state === "failing") return "failing";
    if (state === "pending") pending = true;
  }
  if (pending) return "pending";
  return seen ? "passing" : "none";
}

export function formatRelativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function formatDiffStat(additions: number | null, deletions: number | null): string {
  if (additions === null && deletions === null) return "";
  return `+${additions ?? 0} −${deletions ?? 0}`;
}

export function shortSha(sha: string | null | undefined): string {
  return typeof sha === "string" ? sha.slice(0, 7) : "";
}
