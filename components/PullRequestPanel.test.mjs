import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { PullRequestDetailView, PullRequestList } = await jiti.import("./PullRequestPanel.tsx");

const pr = (overrides = {}) => ({
  repo: "jtsus/phone-order",
  number: 12,
  title: "Add the pull request panel",
  url: "https://github.com/jtsus/phone-order/pull/12",
  state: "open",
  draft: false,
  author: "jtsus",
  head: "agent/add-the-panel",
  base: "main",
  createdAt: "2026-05-01T10:00:00.000Z",
  updatedAt: "2026-05-01T11:00:00.000Z",
  additions: 40,
  deletions: 3,
  changedFiles: 2,
  checks: "passing",
  mergeable: true,
  fromSession: true,
  ...overrides,
});

const render = (element) => renderToStaticMarkup(React.createElement(I18nProvider, null, element));

const list = (overrides = {}) => render(React.createElement(PullRequestList, {
  prs: [pr()],
  scope: "session",
  repo: "jtsus/phone-order",
  error: null,
  loading: false,
  notice: null,
  onOpen() {},
  onScopeChange() {},
  onRefresh() {},
  ...overrides,
}));

test("a row names the pull request, its branches and its diff", () => {
  const html = list();
  assert.match(html, /#12/);
  assert.match(html, /Add the pull request panel/);
  assert.match(html, /agent\/add-the-panel → main/);
  assert.match(html, /\+40 −3/);
  // Both scopes are offered, and the current one is marked selected.
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>This chat</);
  assert.match(html, /All PRs/);
  assert.match(html, /aria-label="Refresh pull requests"/);
});

test("the scope tabs report which list is showing", () => {
  const html = list({ scope: "all" });
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>This chat</);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>All PRs</);
});

test("an empty scope explains itself instead of looking broken", () => {
  const session = list({ prs: [] });
  assert.match(session, /No pull requests from this chat yet/);
  const all = list({ prs: [], scope: "all" });
  assert.match(all, /No open pull requests in this repository/);
});

test("a token or repository problem is shown in the list, not swallowed", () => {
  const html = list({ prs: [], error: "No GitHub token found. Add one to ~/.pi-git-credentials or set GITHUB_TOKEN." });
  assert.match(html, /No GitHub token found/);
  // The hint still tells the reader that merged work leaves the list.
  assert.match(html, /Merged and closed pull requests leave this list/);
});

test("a draft pull request is marked as one", () => {
  const html = list({ prs: [pr({ draft: true })] });
  assert.match(html, /draft/);
});

const detail = {
  ...pr(),
  body: "## Why\n\nAgents lose work when they stop early.",
  commits: 2,
  comments: 1,
  approvals: 1,
  changesRequested: 0,
  files: [
    { filename: "components/PullRequestPanel.tsx", status: "added", additions: 40, deletions: 0, patch: "+first line\n-second line\n context" },
    { filename: "README.md", status: "modified", additions: 1, deletions: 1 },
  ],
  filesTruncated: false,
};

const renderDetail = (overrides = {}) => render(React.createElement(PullRequestDetailView, {
  detail: { ...detail, ...overrides },
  busy: false,
  onBack() {},
  onMerge() {},
  t: (key, params) => {
    const messages = {
      "prs.openOnGitHub": "Open on GitHub",
      "prs.merge": "Merge",
      "prs.mergeConfirm": "Merge this pull request?",
      "prs.files": `Files (${params?.count ?? ""})`,
      "prs.changedFiles": `${params?.count ?? ""} files`,
      "prs.approvals": `${params?.count ?? ""} approval(s)`,
      "prs.back": "Back to list",
      "prs.checks.passing": "Checks passing",
      "prs.checks.failing": "Checks failing",
      "prs.checks.pending": "Checks running",
      "prs.checks.none": "No checks",
      "prs.diffTruncated": "Long diffs are shortened here. Open the pull request on GitHub for the rest.",
      "prs.notMergeable": "GitHub reports this pull request cannot be merged yet.",
      "prs.draft": "draft",
    };
    return messages[key] ?? key;
  },
}));

test("the detail view links to GitHub, renders the body and offers a merge", () => {
  const html = renderDetail();
  assert.match(html, /href="https:\/\/github\.com\/jtsus\/phone-order\/pull\/12"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /Agents lose work when they stop early/);
  assert.match(html, />Merge</);
  assert.match(html, /Files \(2\)/);
  assert.match(html, /components\/PullRequestPanel\.tsx/);
  assert.match(html, /Checks passing/);
  assert.match(html, /1 approval\(s\)/);
});

test("a pull request GitHub cannot merge disables the button", () => {
  const html = renderDetail({ mergeable: false });
  assert.match(html, /disabled=""/);
  assert.match(html, /cannot be merged yet/);
});

test("patches open on demand, so the file list stays short", () => {
  const html = renderDetail();
  // Collapsed by default: the patch text is not in the markup yet.
  assert.equal(html.includes("first line"), false);
  assert.match(html, /README\.md/);
});

test("a truncated diff says where the rest lives", () => {
  const html = renderDetail({ filesTruncated: true });
  assert.match(html, /Open the pull request on GitHub for the rest/);
});
