import { PULL_REQUEST_ENTRY_TYPE, type PullRequestLink } from "./pr-types";
import { normalizeRepoSlug } from "./git-remote";

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value.replace(/^#/, "")) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  return number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * One recorded PR. The agent's extension writes
 * `{ repo, number, url, branch, base, title, worktree, createdAt }`.
 * Anything that does not carry a usable repo and number is dropped rather than
 * guessed at, so a malformed entry cannot poison the list.
 */
export function normalizePullRequestLink(value: unknown): PullRequestLink | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const repo = normalizeRepoSlug(typeof record.repo === "string" ? record.repo : null);
  const number = positiveInteger(record.number ?? record.pr ?? record.id);
  if (!repo || number === null) return null;
  return {
    repo,
    number,
    url: optionalString(record.url ?? record.html_url ?? record.htmlUrl),
    branch: optionalString(record.branch ?? record.head),
    base: optionalString(record.base),
    title: optionalString(record.title),
    worktree: optionalString(record.worktree),
    createdAt: optionalString(record.createdAt ?? record.created_at),
  };
}

/** A session entry payload may hold one link or a list of them. */
function linksFromPayload(payload: unknown): PullRequestLink[] {
  if (Array.isArray(payload)) return payload.map(normalizePullRequestLink).filter(isLink);
  const single = normalizePullRequestLink(payload);
  if (single) return [single];
  if (payload && typeof payload === "object") {
    const nested = (payload as Record<string, unknown>).prs;
    if (Array.isArray(nested)) return nested.map(normalizePullRequestLink).filter(isLink);
  }
  return [];
}

function isLink(link: PullRequestLink | null): link is PullRequestLink {
  return link !== null;
}

/**
 * Every PR this chat recorded, newest last, de-duplicated by repo and number.
 * Reads pi session entries (`type: "custom"`, `customType: "pi.pr"`); other
 * entry types are ignored.
 */
export function pullRequestLinksFromEntries(entries: readonly unknown[]): PullRequestLink[] {
  const byKey = new Map<string, PullRequestLink>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "custom" || record.customType !== PULL_REQUEST_ENTRY_TYPE) continue;
    for (const link of linksFromPayload(record.data)) {
      const key = `${link.repo}#${link.number}`.toLowerCase();
      // A later entry for the same PR wins: it carries the freshest metadata.
      byKey.set(key, { ...byKey.get(key), ...link });
    }
  }
  return [...byKey.values()];
}

export function linkKey(repo: string, number: number): string {
  return `${repo}#${number}`.toLowerCase();
}

/** True when this PR was recorded by any session the panel can see. */
export function hasLink(links: readonly PullRequestLink[], repo: string, number: number): boolean {
  const key = linkKey(repo, number);
  return links.some((link) => linkKey(link.repo, link.number) === key);
}

export function linkForBranch(links: readonly PullRequestLink[], branch: string): PullRequestLink | null {
  return links.find((link) => link.branch === branch) ?? null;
}

/** Repo most of the chat's PRs belong to; ties resolve to the newest link. */
export function dominantRepo(links: readonly PullRequestLink[]): string | null {
  const counts = new Map<string, number>();
  for (const link of links) counts.set(link.repo, (counts.get(link.repo) ?? 0) + 1);
  let best: { repo: string; count: number } | null = null;
  for (const [repo, count] of counts) {
    if (!best || count >= best.count) best = { repo, count };
  }
  return best?.repo ?? null;
}
