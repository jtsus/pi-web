import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

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
  guardMessage,
  isPushToProtectedBranch,
  pathsFromToolCall,
} = await jiti.import("./index.ts");
const { parseRepoRemote, tokenFromCredentialStore } = await jiti.import("./github.ts");

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
