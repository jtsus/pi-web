import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  dominantRepo,
  hasLink,
  linkForBranch,
  normalizePullRequestLink,
  pullRequestLinksFromEntries,
} = await jiti.import("./pr-links.ts");

const entry = (data, customType = "pi.pr") => ({ type: "custom", id: "x", parentId: null, timestamp: "t", customType, data });

test("reads one link or a list from pi.pr entries", () => {
  const links = pullRequestLinksFromEntries([
    entry({ repo: "jtsus/phone-order", number: 12, url: "https://github.com/jtsus/phone-order/pull/12", branch: "agent/x" }),
    entry({ prs: [{ repo: "jtsus/phone-order", number: 13 }, { repo: "o/r", number: 1 }] }),
  ]);
  assert.equal(links.length, 3);
  assert.deepEqual(links[0], {
    repo: "jtsus/phone-order",
    number: 12,
    url: "https://github.com/jtsus/phone-order/pull/12",
    branch: "agent/x",
    base: undefined,
    title: undefined,
    worktree: undefined,
    createdAt: undefined,
  });
  assert.equal(links[1].number, 13);
  assert.equal(links[2].repo, "o/r");
});

test("ignores other entry types and malformed numbers", () => {
  const links = pullRequestLinksFromEntries([
    { type: "message", customType: "pi.pr", data: { repo: "o/r", number: 1 } },
    entry({ repo: "o/r", number: 1 }, "other.type"),
    entry({ repo: "o/r" }),
    entry({ repo: "not a slug", number: 2 }),
    entry({ repo: "o/r", number: -1 }),
    entry({ repo: "o/r", number: 0 }),
    entry({ repo: "o/r", number: "3" }),
    null,
    "nonsense",
  ]);
  assert.equal(links.length, 1);
  assert.equal(links[0].number, 3);
});

test("a later entry for the same PR wins", () => {
  const links = pullRequestLinksFromEntries([
    entry({ repo: "o/r", number: 5, title: "old" }),
    entry({ repo: "o/r", number: 5, title: "new", worktree: "/tmp/wt" }),
  ]);
  assert.equal(links.length, 1);
  assert.equal(links[0].title, "new");
  assert.equal(links[0].worktree, "/tmp/wt");
});

test("helpers answer membership, branch and dominant repo", () => {
  const links = [
    { repo: "o/r", number: 1, branch: "agent/a" },
    { repo: "o/r", number: 2, branch: "agent/b" },
    { repo: "o/other", number: 9 },
  ];
  assert.equal(hasLink(links, "O/R", 2), true);
  assert.equal(hasLink(links, "o/r", 7), false);
  assert.equal(linkForBranch(links, "agent/b")?.number, 2);
  assert.equal(linkForBranch(links, "missing"), null);
  assert.equal(dominantRepo(links), "o/r");
  assert.equal(dominantRepo([]), null);
});

test("normalizePullRequestLink rejects a number without a repo", () => {
  assert.equal(normalizePullRequestLink({ number: 4 }), null);
  assert.equal(normalizePullRequestLink(null), null);
  assert.equal(normalizePullRequestLink({ repo: "o/r", number: 4 })?.number, 4);
});
