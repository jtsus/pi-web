import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);
const jiti = createJiti(import.meta.url);
const {
  branchFromTitle,
  isProtectedBranch,
  parsePorcelainPaths,
  repoRelativePaths,
  scopedDirtyPaths,
  worktreePathFor,
} = await jiti.import("./git.ts");
const {
  allowedPathsFor,
  gapFingerprint,
  guardMessage,
  inspectionGap,
  isPushToProtectedBranch,
  pathsFromToolCall,
} = await jiti.import("./index.ts");
const { parseRepoRemote, tokenFromCredentialStore } = await jiti.import("./github.ts");

/** The modules of the extension as one namespace, for tests that need several. */
async function loadSubject() {
  return {
    ...(await jiti.import("./git.ts")),
    ...(await jiti.import("./index.ts")),
    ...(await jiti.import("./github.ts")),
  };
}

test("parses porcelain -z records into paths", () => {
  const output = " M src/app.ts\0?? notes/new file.md\0A  added.txt\0";
  assert.deepEqual(parsePorcelainPaths(output), ["src/app.ts", "notes/new file.md", "added.txt"]);
  assert.deepEqual(parsePorcelainPaths(""), []);
});

test("branch names stay short and git-safe", () => {
  assert.equal(branchFromTitle("Fix the login page!", "ab12"), "agent/fix-the-login-page-ab12");
  assert.equal(branchFromTitle(undefined, "zz"), "agent/work-zz");
  assert.match(branchFromTitle("Ünïcode ünd spaces", ""), /^agent\/n-code-nd-spaces-[a-z0-9]+$/);
  assert.equal(branchFromTitle("x".repeat(300), "s").length <= 56, true);
});

test("main, master, HEAD and the base branch are protected", () => {
  assert.equal(isProtectedBranch("main", "main"), true);
  assert.equal(isProtectedBranch("master", "main"), true);
  assert.equal(isProtectedBranch("HEAD", "main"), true);
  assert.equal(isProtectedBranch("trunk", "trunk"), true);
  assert.equal(isProtectedBranch("agent/fix", "main"), false);
});

test("worktrees sit next to the repository, one folder per branch", () => {
  assert.equal(worktreePathFor("/home/u/repo", "agent/fix-it"), "/home/u/repo-worktrees/agent-fix-it");
  assert.equal(worktreePathFor("/home/u/repo", "a/b c"), "/home/u/repo-worktrees/a-b-c");
});

test("only pushes to protected branches are blocked", () => {
  assert.equal(isPushToProtectedBranch("git push origin main"), true);
  assert.equal(isPushToProtectedBranch("git push -u origin master"), true);
  assert.equal(isPushToProtectedBranch("cd repo && git push origin main --force"), true);
  assert.equal(isPushToProtectedBranch("git push origin agent/fix-main-title"), false);
  assert.equal(isPushToProtectedBranch("git status"), false);
  assert.equal(isPushToProtectedBranch("git commit -m 'remove main'"), false);
  assert.equal(isPushToProtectedBranch("echo git push origin maintenance"), false);
});

test("the guard message names every reason and the way out", () => {
  const message = guardMessage({
    needsShipping: true,
    reasons: ["2 uncommitted file(s) in /repo: a.ts, b.ts", "branch agent/x has no open pull request"],
  });
  assert.match(message, /2 uncommitted file/);
  assert.match(message, /no open pull request/);
  assert.match(message, /pr_ship/);
  assert.match(message, /pull request URL/);
});

test("the extension resolves github remotes and tokens like the web app", () => {
  assert.deepEqual(parseRepoRemote("git@github.com:jtsus/phone-order.git"), {
    repo: "jtsus/phone-order",
    host: "github.com",
  });
  assert.deepEqual(parseRepoRemote("https://example.com/not/github"), { repo: "not/github", host: "example.com" });
  assert.equal(parseRepoRemote("https://example.com/onlyone"), null);
  assert.equal(tokenFromCredentialStore("https://user: ghp_x@github.com"), null);
  assert.equal(tokenFromCredentialStore("https://user:ghp_x@github.com"), "ghp_x");
});



test("only the session's paths are shipped, never other work in the checkout", () => {
  const scope = {
    touched: ["/repo/src/app.ts", "/repo/notes/new.md"],
    baseline: new Set(["apps/api/app/main.py"]),
    baselineRoot: "/repo",
  };
  const currentDirty = ["src/app.ts", "notes/new.md", "apps/api/app/main.py", "unrelated.txt"];
  // touched files plus anything that became dirty after the session started.
  assert.deepEqual(allowedPathsFor(scope, "/repo", currentDirty), ["notes/new.md", "src/app.ts", "unrelated.txt"]);
  // The file that was already dirty at session start is not the session's to commit.
  assert.deepEqual(
    scopedDirtyPaths(currentDirty, allowedPathsFor(scope, "/repo", currentDirty)),
    ["src/app.ts", "notes/new.md", "unrelated.txt"],
  );
  // A different checkout (a fresh worktree) has no baseline: everything there is ours.
  assert.equal(allowedPathsFor(scope, "/repo-worktrees/x", currentDirty), null);
});

test("tool call arguments name the files a session wrote", () => {
  assert.deepEqual(pathsFromToolCall("write", { path: "/repo/a.ts", content: "x" }), ["/repo/a.ts"]);
  assert.deepEqual(pathsFromToolCall("edit", { file_path: "/repo/b.ts" }), ["/repo/b.ts"]);
  assert.deepEqual(pathsFromToolCall("patch", { paths: ["/repo/c", "/repo/d"] }), ["/repo/c", "/repo/d"]);
  assert.deepEqual(pathsFromToolCall("bash", { command: "ls" }), []);
  assert.deepEqual(pathsFromToolCall("read", null), []);
});

test("absolute paths inside the repository become relative ones", () => {
  assert.deepEqual(repoRelativePaths("/repo", ["/repo/b.ts", "/repo/a.ts", "/repo/a.ts"]), ["a.ts", "b.ts"]);
  assert.deepEqual(repoRelativePaths("/repo", ["/other/x.ts", "/repo"]), []);
});

// --- work counts as shipped once the branch is pushed, not once it is merged --

const runGet = (cwd, args) => execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const runGit = (...args) => execFileAsync("git", args, { encoding: "utf8" });

/** A cloned repository whose origin is a bare repo next to it, with one commit on main. */
async function makeRepo(t) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-pr-guard-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const origin = path.join(tempRoot, "origin.git");
  const repo = path.join(tempRoot, "repo");
  await runGit("init", "--bare", "-b", "main", origin);
  await runGit("clone", origin, repo);
  await runGet(repo, ["config", "user.name", "pi-pr test"]);
  await runGet(repo, ["config", "user.email", "pi-pr-test@example.invalid"]);
  await runGet(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "a.txt"), "one\n");
  await runGet(repo, ["add", "-A"]);
  await runGet(repo, ["commit", "-m", "initial"]);
  await runGet(repo, ["push", "origin", "main"]);
  await runGet(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  return { repo, tempRoot };
}

test("a branch whose commits origin already has is not unshipped work", async (t) => {
  const { repo } = await makeRepo(t);
  await runGet(repo, ["checkout", "-b", "agent/work"]);
  await writeFile(path.join(repo, "a.txt"), "two\n");
  await runGet(repo, ["commit", "-am", "agent work"]);
  await runGet(repo, ["push", "-u", "origin", "agent/work"]);

  const { readRepoState } = await loadSubject();
  const state = await readRepoState(repo);
  // Its commits are not on origin/main until the pull request merges; that is
  // not a reason to keep telling the session to ship.
  assert.equal(state.ahead, 0);
  assert.equal(state.aheadOf, "origin/agent/work");

  const gap = await inspectionGap(repo, { targets: [{ path: repo }] });
  assert.deepEqual(gap.reasons, []);
});

test("unpushed commits and dirty files still count on either branch", async (t) => {
  const { repo } = await makeRepo(t);
  const { readRepoState } = await loadSubject();

  await writeFile(path.join(repo, "a.txt"), "two\n");
  const dirtyOnMain = await readRepoState(repo);
  assert.equal(dirtyOnMain.branch, "main");
  assert.deepEqual(dirtyOnMain.dirtyPaths, ["a.txt"]);
  const mainGap = await inspectionGap(repo, { targets: [{ path: repo }] });
  assert.equal(mainGap.needsShipping, true);
  assert.match(mainGap.reasons.join("\n"), /uncommitted file/);

  await runGet(repo, ["stash", "push", "-u"]);
  await runGet(repo, ["checkout", "-b", "agent/work"]);
  await writeFile(path.join(repo, "a.txt"), "two\n");
  await runGet(repo, ["commit", "-am", "agent work"]);
  const unpushed = await readRepoState(repo);
  assert.equal(unpushed.ahead, 1);
  assert.equal(unpushed.aheadOf, "origin/main");
  const branchGap = await inspectionGap(repo, { targets: [{ path: repo }] });
  assert.match(branchGap.reasons.join("\n"), /not pushed to origin\/main/);
});

test("the guard nudges once per gap, not once per run", () => {
  const gap = { needsShipping: true, reasons: ["1 uncommitted file(s) in /repo: a.ts"], branch: "agent/x", headSha: "abc" };
  assert.equal(gapFingerprint(gap), gapFingerprint({ ...gap, reasons: [...gap.reasons] }));
  assert.notEqual(gapFingerprint(gap), gapFingerprint({ ...gap, headSha: "def" }));
  assert.notEqual(gapFingerprint(gap), gapFingerprint({ ...gap, reasons: ["2 uncommitted file(s) in /repo: a.ts, b.ts"] }));
});

test("a merged pull request settles a branch", async (t) => {
  const { findPullForBranch, findOpenPull } = await loadSubject();
  const previousToken = process.env.GITHUB_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = "test-token";
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  });
  const pulls = [
    { number: 7, state: "closed", merged: true, head: { ref: "agent/work" }, html_url: "u" },
    { number: 8, state: "closed", merged: false, head: { ref: "agent/other" } },
  ];
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(String(url).includes("state=open") ? [] : pulls),
  });

  assert.equal((await findPullForBranch("o/r", "agent/work"))?.number, 7);
  // Opening a new pull request still needs an open one to reuse.
  assert.equal(await findOpenPull("o/r", "agent/work"), null);
});

test("a GitHub outage is not read as a missing pull request", async (t) => {
  const { repo } = await makeRepo(t);
  await runGet(repo, ["checkout", "-b", "agent/work"]);
  await writeFile(path.join(repo, "a.txt"), "two\n");
  await runGet(repo, ["commit", "-am", "agent work"]);
  await runGet(repo, ["push", "-u", "origin", "agent/work"]);
  // From here the remote looks like GitHub; the tracking ref is already local,
  // so nothing has to be reachable for the guard to inspect the branch.
  await runGet(repo, ["remote", "set-url", "origin", "git@github.com:owner/repo.git"]);

  const previousToken = process.env.GITHUB_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = "test-token";
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  });

  globalThis.fetch = async () => { throw new Error("rate limited"); };
  assert.deepEqual((await inspectionGap(repo, { targets: [{ path: repo }] })).reasons, []);

  // A reachable GitHub that has no pull request for the branch still counts.
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "[]" });
  const quiet = await inspectionGap(repo, { targets: [{ path: repo }] });
  assert.deepEqual(quiet.reasons, ["branch agent/work has no pull request"]);
});
