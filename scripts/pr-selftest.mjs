#!/usr/bin/env node
/**
 * End-to-end check of the pi-pr ship flow against a real GitHub repository.
 *
 *   node scripts/pr-selftest.mjs /path/to/a/github/checkout
 *
 * The checkout must be on its default branch with a github.com `origin` and a
 * token in ~/.pi-git-credentials (or GITHUB_TOKEN). The script writes a scratch
 * file, ships it, prints the pull request it opened, and leaves the PR open so
 * it can be inspected in the Pi Web panel. Close it on GitHub afterwards.
 */
import { createJiti } from "jiti";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/pr-selftest.mjs <git checkout>");
  process.exit(2);
}

const jiti = createJiti(import.meta.url);
const { inspectionGap, shipWork, startWorktree } = await jiti.import("../extensions/pi-pr/index.ts");

console.log("gap before:", await inspectionGap(target));
console.log("worktree:", await startWorktree(target, { title: "selftest worktree" }).catch((error) => `failed: ${error.message}`));
const result = await shipWork(target, {
  title: "pi-pr selftest: verify the ship flow",
  body: "Opened by `scripts/pr-selftest.mjs` to verify that pi-pr commits, pushes, and opens a pull request. Safe to close.",
});
console.log("ship:", JSON.stringify(result, null, 2));
console.log("gap after:", await inspectionGap(target));
process.exit(result.ok ? 0 : 1);
