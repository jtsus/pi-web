import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildPullRequestMergePrompt } = await jiti.import("./pr-merge-prompt.ts");

const pull = {
  repo: "jtsus/pi-web",
  number: 42,
  title: "Draw ask_user questions in the chat",
  url: "https://github.com/jtsus/pi-web/pull/42",
  head: "ask-user-web-ui",
  base: "pull-requests",
};

test("the merge prompt names the pull request, the method and the command", () => {
  const prompt = buildPullRequestMergePrompt(pull);

  assert.match(prompt, /^Merge pull request #42 in jtsus\/pi-web \(ask-user-web-ui → pull-requests\) with a squash merge\./);
  assert.match(prompt, /Title: "Draw ask_user questions in the chat"\./);
  assert.match(prompt, /https:\/\/github\.com\/jtsus\/pi-web\/pull\/42/);
  assert.match(prompt, /`gh pr merge 42 --repo jtsus\/pi-web --squash`/);
  assert.match(prompt, /Do the merge yourself now/);
  assert.match(prompt, /watch the deploy this triggers until it has gone out successfully/);
  assert.match(prompt, /confirm the new revision is actually running/);
  assert.match(prompt, /Do not claim the merge or the deploy succeeded without checking/);
});

test("a merge commit and a rebase use their own flag and wording", () => {
  const merged = buildPullRequestMergePrompt(pull, "merge");
  assert.match(merged, /with a merge commit\./);
  assert.match(merged, /--merge`/);

  const rebased = buildPullRequestMergePrompt(pull, "rebase");
  assert.match(rebased, /with a rebase merge\./);
  assert.match(rebased, /--rebase`/);
});

test("a pull request without a title or URL leaves no blank lines behind", () => {
  const prompt = buildPullRequestMergePrompt({ ...pull, title: "", url: "" }, "squash");
  const intro = prompt.split("\n\n")[0];
  assert.equal(intro, "Merge pull request #42 in jtsus/pi-web (ask-user-web-ui → pull-requests) with a squash merge.");
  assert.doesNotMatch(prompt, /Title:/);
  assert.doesNotMatch(prompt, /Pull request: https/);
});
