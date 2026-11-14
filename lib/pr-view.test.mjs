import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  combineChecks,
  formatDiffStat,
  formatRelativeTime,
  isVisiblePullRequest,
  parsePullRequestScope,
  pullRequestState,
  shortSha,
  sortPullRequests,
} = await jiti.import("./pr-view.ts");

const pr = (overrides) => ({
  repo: "o/r",
  number: 1,
  title: "t",
  url: "u",
  state: "open",
  draft: false,
  author: null,
  head: "h",
  base: "main",
  createdAt: null,
  updatedAt: null,
  additions: null,
  deletions: null,
  changedFiles: null,
  checks: "none",
  mergeable: null,
  fromSession: false,
  ...overrides,
});

test("only open pull requests stay visible", () => {
  assert.equal(pullRequestState("open", false), "open");
  assert.equal(pullRequestState("closed", true), "merged");
  assert.equal(pullRequestState("closed", false), "closed");
  assert.equal(isVisiblePullRequest(pr({})), true);
  assert.equal(isVisiblePullRequest(pr({ state: "merged" })), false);
  assert.equal(isVisiblePullRequest(pr({ state: "closed" })), false);
});

test("session pull requests come first, then newest", () => {
  const sorted = sortPullRequests([
    pr({ number: 1, updatedAt: "2026-01-01T00:00:00.000Z" }),
    pr({ number: 2, updatedAt: "2026-02-01T00:00:00.000Z" }),
    pr({ number: 3, updatedAt: "2026-01-15T00:00:00.000Z", fromSession: true }),
  ]);
  assert.deepEqual(sorted.map((item) => item.number), [3, 2, 1]);
});

test("checks roll up worst-first", () => {
  assert.equal(combineChecks([]), "none");
  assert.equal(combineChecks(["none", null, undefined]), "none");
  assert.equal(combineChecks(["passing", "pending"]), "pending");
  assert.equal(combineChecks(["passing", "failing", "pending"]), "failing");
  assert.equal(combineChecks(["passing", "passing"]), "passing");
});

test("scope parsing accepts only the two known scopes", () => {
  assert.equal(parsePullRequestScope("session"), "session");
  assert.equal(parsePullRequestScope("all"), "all");
  assert.equal(parsePullRequestScope("everything"), null);
  assert.equal(parsePullRequestScope(null), null);
});

test("formatting helpers stay compact", () => {
  const now = Date.parse("2026-05-01T12:00:00.000Z");
  assert.equal(formatRelativeTime("2026-05-01T11:59:30.000Z", now), "just now");
  assert.equal(formatRelativeTime("2026-05-01T11:30:00.000Z", now), "30m ago");
  assert.equal(formatRelativeTime("2026-05-01T06:00:00.000Z", now), "6h ago");
  assert.equal(formatRelativeTime("2026-04-20T12:00:00.000Z", now), "11d ago");
  assert.equal(formatRelativeTime("2025-05-01T12:00:00.000Z", now), "1y ago");
  assert.equal(formatRelativeTime(null, now), "");
  assert.equal(formatRelativeTime("garbage", now), "");
  assert.equal(formatDiffStat(12, 3), "+12 −3");
  assert.equal(formatDiffStat(null, 3), "+0 −3");
  assert.equal(formatDiffStat(null, null), "");
  assert.equal(shortSha("0123456789abcdef"), "0123456");
  assert.equal(shortSha(null), "");
});
