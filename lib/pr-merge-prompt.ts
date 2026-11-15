import type { PullRequestDetail, PullRequestMergeMethod } from "./pr-types";

/**
 * What the PR panel's Merge button sends to the chat that owns the pull
 * request. The chat's agent does the merge itself (so it sees the checks and
 * failures the panel would only report as a red notice) and then watches the
 * deploy that follows, instead of the panel merging behind its back.
 */

const METHOD: Record<PullRequestMergeMethod, { text: string; flag: string }> = {
  squash: { text: "squash merge", flag: "--squash" },
  merge: { text: "merge commit", flag: "--merge" },
  rebase: { text: "rebase merge", flag: "--rebase" },
};

export type PullRequestPromptFields = Pick<
  PullRequestDetail,
  "repo" | "number" | "title" | "url" | "head" | "base"
>;

export function buildPullRequestMergePrompt(
  pull: PullRequestPromptFields,
  method: PullRequestMergeMethod = "squash",
): string {
  const { text, flag } = METHOD[method];
  const intro = [
    `Merge pull request #${pull.number} in ${pull.repo} (${pull.head} → ${pull.base}) with a ${text}.`,
    pull.title ? `Title: "${pull.title}".` : "",
    pull.url ? `Pull request: ${pull.url}` : "",
  ].filter(Boolean).join("\n");

  return [
    intro,
    `Do the merge yourself now with your GitHub tooling, for example \`gh pr merge ${pull.number} --repo ${pull.repo} ${flag}\`. Do not ask me to click Merge again.`,
    "After merging, watch the deploy this triggers until it has gone out successfully: follow the deploy workflow/CI run, then check the live rollout (the deployment or cluster state, or the Deployments tab) and confirm the new revision is actually running.",
    "If the checks fail, the merge fails, or the deploy fails or stalls, investigate and report what failed here. Do not claim the merge or the deploy succeeded without checking.",
    "If you cannot find the deploy workflow, ask me where it is instead of guessing.",
  ].join("\n\n");
}
