import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { tokenFromCredentialStore, tokenFromGhHosts } = await jiti.import("./gh-token.ts");

test("reads the github.com line of a git credential store", () => {
  const store = [
    "https://user:ghp_example@github.com",
    "https://other:secret@bitbucket.org",
  ].join("\n");
  assert.equal(tokenFromCredentialStore(store), "ghp_example");
  assert.equal(tokenFromCredentialStore("https://other:secret@bitbucket.org"), null);
  assert.equal(tokenFromCredentialStore(""), null);
  assert.equal(tokenFromCredentialStore("https://user:ghp_x@github.com/extra"), null);
});

test("decodes an encoded secret", () => {
  assert.equal(tokenFromCredentialStore("https://user:ghp%2Ftail@github.com"), "ghp/tail");
});

test("reads gh auth hosts.yml without matching another host", () => {
  const hosts = [
    "github.com:",
    "    user: jtsus",
    "    oauth_token: gho_example",
    "    git_protocol: https",
    "ghe.example.com:",
    "    user: other",
    "    oauth_token: gho_other",
  ].join("\n");
  assert.equal(tokenFromGhHosts(hosts), "gho_example");
  assert.equal(tokenFromGhHosts("ghe.example.com:\n    oauth_token: gho_other"), null);
  assert.equal(tokenFromGhHosts(""), null);
});
