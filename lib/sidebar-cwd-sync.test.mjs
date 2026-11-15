import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldFollowSessionCwd } = await jiti.import("./sidebar-cwd-sync.ts");

test("a session switch follows the session even when its cwd equals the last prop", () => {
  assert.equal(shouldFollowSessionCwd({
    propCwd: "/work/wt",
    sessionId: "session-b",
    lastPropCwd: "/work/wt",
    lastSessionId: "session-a",
  }), true);
});

test("a manual picker move with the session unchanged is not snapped back", () => {
  assert.equal(shouldFollowSessionCwd({
    propCwd: "/work/wt",
    sessionId: "session-a",
    lastPropCwd: "/work/wt",
    lastSessionId: "session-a",
  }), false);
});

test("a new prop value follows, and a null prop has nothing to follow", () => {
  assert.equal(shouldFollowSessionCwd({
    propCwd: "/work/other",
    sessionId: "session-a",
    lastPropCwd: "/work/wt",
    lastSessionId: "session-a",
  }), true);
  assert.equal(shouldFollowSessionCwd({
    propCwd: null,
    sessionId: null,
    lastPropCwd: "/work/wt",
    lastSessionId: "session-a",
  }), false);
});
