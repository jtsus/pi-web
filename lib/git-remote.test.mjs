import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isGitHubHost, normalizeRepoSlug, parseGitHubRemote } = await jiti.import("./git-remote.ts");

test("reads every remote shape git produces", () => {
  const expected = { repo: "jtsus/phone-order", host: "github.com" };
  for (const remote of [
    "https://github.com/jtsus/phone-order.git",
    "https://github.com/jtsus/phone-order",
    "git@github.com:jtsus/phone-order.git",
    "ssh://git@github.com/jtsus/phone-order.git",
    "git://github.com/jtsus/phone-order",
    "https://user:token@github.com/jtsus/phone-order.git",
    "https://GitHub.com/jtsus/phone-order/",
  ]) {
    assert.deepEqual(parseGitHubRemote(remote), expected, remote);
  }
});

test("keeps the last two path segments and rejects everything else", () => {
  assert.deepEqual(parseGitHubRemote("git@gitlab.com:group/sub/repo.git"), {
    repo: "sub/repo",
    host: "gitlab.com",
  });
  for (const remote of ["", "   ", "not a url", "https://github.com/onlyowner", "git@github.com:repo.git", null, undefined]) {
    assert.equal(parseGitHubRemote(remote), null, String(remote));
  }
});

test("normalizes slugs the API passes back", () => {
  assert.equal(normalizeRepoSlug(" jtsus/phone-order "), "jtsus/phone-order");
  assert.equal(normalizeRepoSlug("jtsus/phone-order.git"), "jtsus/phone-order");
  assert.equal(normalizeRepoSlug("/jtsus/phone-order"), "jtsus/phone-order");
  assert.equal(normalizeRepoSlug("jtsus"), null);
  assert.equal(normalizeRepoSlug("jtsus/phone-order/extra"), null);
  assert.equal(normalizeRepoSlug("js tus/phone-order"), null);
  assert.equal(normalizeRepoSlug(""), null);
  assert.equal(normalizeRepoSlug(null), null);
});

test("recognizes the github hosts it talks to", () => {
  assert.equal(isGitHubHost("github.com"), true);
  assert.equal(isGitHubHost("www.github.com"), true);
  assert.equal(isGitHubHost("GitHub.com"), true);
  assert.equal(isGitHubHost("ghe.example.com"), false);
});
