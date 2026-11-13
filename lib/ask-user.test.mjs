import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ASK_USER_EXTENSION_PATH,
  ASK_USER_TOOL_NAME,
  askUserToolDefinition,
  cancelledAskUserResult,
  formatAskUserResponseSummary,
  formatAskUserResult,
  loadAskUserSettings,
  normalizeAskUserParams,
  parseAskUserAnswers,
  preferPiWebAskUserExtension,
  resolveAskUserDefaults,
} = await jiti.import("./ask-user.ts");

const NO_DEFAULTS = { allowComment: false, contextExpanded: false };

function parse(params, defaults = NO_DEFAULTS) {
  return normalizeAskUserParams(params, defaults);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("ask-user settings read only the keys the chat uses", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-ask-user-"));
  const file = join(dir, "ask-user.json");
  assert.deepEqual(loadAskUserSettings(file), {});

  writeFileSync(file, JSON.stringify({
    displayMode: "inline",
    singleSelectLayout: "list",
    overlayToggleKey: "alt+h",
    allowComment: true,
    contextExpanded: true,
    emitFullEvents: true,
  }));
  assert.deepEqual(loadAskUserSettings(file), { allowComment: true, contextExpanded: true });

  writeFileSync(file, "{ not json");
  assert.throws(() => loadAskUserSettings(file), /Failed to parse ask-user settings at .*ask-user\.json/);
});

test("environment preferences win over the settings file", () => {
  const settings = { allowComment: true, contextExpanded: true };
  assert.deepEqual(resolveAskUserDefaults({}, settings), { allowComment: true, contextExpanded: true });
  assert.deepEqual(
    resolveAskUserDefaults({ PI_ASK_USER_ALLOW_COMMENT: "off", PI_ASK_USER_CONTEXT_EXPANDED: "1" }, settings),
    { allowComment: false, contextExpanded: true },
  );
  assert.deepEqual(
    resolveAskUserDefaults({ PI_ASK_USER_ALLOW_COMMENT: "maybe" }, settings),
    { allowComment: true, contextExpanded: true },
  );
});

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

test("a single question coerces options, defaults, and call options", () => {
  const { ask, options } = parse({
    question: "  Pick a colour  ",
    context: "  The header is blue.  ",
    options: ["Red", { label: "Blue", description: "the current one" }, { value: 3 }, { nope: true }],
    allowMultiple: true,
    allowComment: true,
    contextExpanded: true,
    timeout: 90_000,
  });

  assert.equal(ask.kind, "single");
  assert.equal(ask.question.question, "Pick a colour");
  assert.equal(ask.question.context, "The header is blue.");
  assert.deepEqual(ask.question.options, [
    { title: "Red" },
    { title: "Blue", description: "the current one" },
  ]);
  assert.equal(ask.question.allowMultiple, true);
  assert.equal(ask.question.allowFreeform, true);
  assert.deepEqual(options, { allowComment: true, contextExpanded: true, timeout: 90_000 });
});

test("a call with no arguments, or only malformed options, is refused", () => {
  assert.throws(() => parse({}), /ask_user needs question/);
  assert.throws(() => parse({ question: "   " }), /ask_user needs question/);
  assert.throws(
    () => parse({ question: "Pick", options: [{ nope: true }, { nope: false }] }),
    /All 2 option\(s\) were malformed/,
  );
  assert.throws(() => parse({ question: "Pick", options: "Red" }), /options must be an array/);
});

test("batches validate entries, headings, and misplaced top-level fields", () => {
  const { ask } = parse({
    question: "  Two decisions  ",
    questions: [
      { question: "Which database?", options: ["Postgres", "SQLite"], allowMultiple: false },
      { question: "Which port?", context: "The server reads PORT.", allowFreeform: false },
    ],
  });
  assert.equal(ask.kind, "batch");
  assert.equal(ask.heading, "Two decisions");
  assert.deepEqual(ask.questions.map((question) => question.question), ["Which database?", "Which port?"]);
  assert.equal(ask.questions[0].allowMultiple, false);
  assert.equal(ask.questions[1].allowFreeform, false);
  assert.equal(ask.questions[1].context, "The server reads PORT.");

  assert.throws(
    () => parse({ questions: [{ question: "a" }, { question: "b" }], options: ["x"] }),
    /cannot be set at the top level together with questions/,
  );
  assert.throws(() => parse({ questions: [{ question: "only" }] }), /To ask one question, use question instead/);
  assert.throws(
    () => parse({ questions: [{ question: "a" }, { question: "b" }, { question: "c" }, { question: "d" }, { question: "e" }] }),
    /at most 4 entries/,
  );
  assert.throws(
    () => parse({ questions: [{ question: "Same" }, { question: " same " }] }),
    /repeats the question/,
  );
  assert.throws(() => parse({ questions: [{ question: "a" }, { question: "  " }] }), /questions\[1\]\.question/);
});

// ---------------------------------------------------------------------------
// Answers and results
// ---------------------------------------------------------------------------

const SINGLE = {
  question: "Pick one",
  options: [{ title: "Red" }, { title: "Blue" }],
  allowMultiple: false,
  allowFreeform: true,
};
const MULTI = { ...SINGLE, allowMultiple: true };

test("answers are trimmed, deduplicated, and checked against the offered options", () => {
  assert.deepEqual(
    parseAskUserAnswers([{ kind: "selection", selections: [" Red ", "Red"], comment: "  the default  " }], [SINGLE]),
    [{ kind: "selection", selections: ["Red"], comment: "the default" }],
  );
  assert.deepEqual(
    parseAskUserAnswers([{ kind: "freeform", text: "  Teal  " }], [SINGLE]),
    [{ kind: "freeform", text: "Teal" }],
  );
  assert.deepEqual(
    parseAskUserAnswers([{ kind: "selection", selections: ["Red", "Blue"] }], [MULTI]),
    [{ kind: "selection", selections: ["Red", "Blue"] }],
  );

  assert.throws(
    () => parseAskUserAnswers([{ kind: "selection", selections: ["Green"] }], [SINGLE]),
    /not one of the offered answers/,
  );
  assert.throws(
    () => parseAskUserAnswers([{ kind: "selection", selections: ["Red", "Blue"] }], [SINGLE]),
    /not one of the offered answers/,
  );
  assert.throws(
    () => parseAskUserAnswers([{ kind: "freeform", text: "   " }], [SINGLE]),
    /not one of the offered answers/,
  );
  assert.throws(
    () => parseAskUserAnswers([{ kind: "skipped" }], [SINGLE]),
    /needs an answer to the question/,
  );
  assert.throws(() => parseAskUserAnswers([], [SINGLE]), /needs 1 answer/);
  assert.throws(
    () => parseAskUserAnswers([{ kind: "freeform", text: "no field" }], [{ ...SINGLE, allowFreeform: false }]),
    /not one of the offered answers/,
  );
});

test("a written answer is allowed when the question offers no options", () => {
  const open = { question: "Anything else?", options: [], allowMultiple: false, allowFreeform: false };
  assert.deepEqual(
    parseAskUserAnswers([{ kind: "freeform", text: "Ship it" }], [open]),
    [{ kind: "freeform", text: "Ship it" }],
  );
});

test("results keep pi-ask-user's content and details shapes", () => {
  const { ask } = parse({ question: "Pick one", options: ["Red", "Blue"] });
  const result = formatAskUserResult(ask, {
    kind: "answered",
    answers: [{ kind: "selection", selections: ["Blue"], comment: "matches the logo" }],
  });
  assert.deepEqual(result.content, [{ type: "text", text: "User answered: Blue — matches the logo" }]);
  assert.deepEqual(result.details, {
    question: "Pick one",
    options: [{ title: "Red" }, { title: "Blue" }],
    response: { kind: "selection", selections: ["Blue"], comment: "matches the logo" },
    cancelled: false,
  });
  assert.deepEqual(cancelledAskUserResult(ask).details, {
    question: "Pick one",
    options: [{ title: "Red" }, { title: "Blue" }],
    response: null,
    cancelled: true,
  });
  assert.equal(formatAskUserResponseSummary({ kind: "freeform", text: "Teal" }), "Teal");
});

test("a batch result lists every question and counts the answered ones", () => {
  const { ask } = parse({
    question: "Setup",
    questions: [
      { question: "Database?", options: ["Postgres", "SQLite"] },
      { question: "Port?" },
    ],
  });
  const result = formatAskUserResult(ask, {
    kind: "answered",
    answers: [{ kind: "selection", selections: ["SQLite"] }, { kind: "skipped" }],
  });
  assert.equal(result.content[0].text, [
    "Setup",
    "User answered 1 of 2 questions:",
    "1. Database? → SQLite",
    "2. Port? → (skipped)",
  ].join("\n"));
  assert.deepEqual(result.details.answers, [
    { status: "answered", response: { kind: "selection", selections: ["SQLite"] } },
    { status: "skipped" },
  ]);

  const cancelled = formatAskUserResult(ask, { kind: "cancelled" });
  assert.equal(cancelled.content[0].text, "User cancelled the questions");
  assert.deepEqual(cancelled.details.answers, []);
  assert.equal(cancelled.details.cancelled, true);
});

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

test("the ask_user tool waits on the host and records the answer", async () => {
  const requests = [];
  const definition = askUserToolDefinition(async (request) => {
    requests.push(request);
    return { kind: "answered", answers: [{ kind: "selection", selections: ["Blue"] }] };
  });

  assert.equal(definition.name, ASK_USER_TOOL_NAME);
  assert.equal(definition.exposure, "model-only");
  assert.equal(definition.executionMode, "sequential");

  const result = await definition.execute(
    "call-1",
    { question: "Pick one", options: ["Red", "Blue"], allowComment: true },
    undefined,
    undefined,
    {},
  );
  assert.deepEqual(requests, [{
    questions: [{ question: "Pick one", options: [{ title: "Red" }, { title: "Blue" }], allowMultiple: false, allowFreeform: true }],
    allowComment: true,
    contextExpanded: false,
  }]);
  assert.equal(result.content[0].text, "User answered: Blue");
  assert.equal(result.details.response.kind, "selection");
});

test("the ask_user tool reports cancellation, including a stopped call", async () => {
  const host = async () => ({ kind: "cancelled" });
  const cancelled = await askUserToolDefinition(host).execute("call-2", { question: "Go?" }, undefined, undefined, {});
  assert.equal(cancelled.content[0].text, "User cancelled the question");
  assert.equal(cancelled.details.cancelled, true);

  const aborted = new AbortController();
  aborted.abort();
  const stopped = await askUserToolDefinition(host).execute("call-3", { question: "Go?" }, aborted.signal, undefined, {});
  assert.equal(stopped.content[0].text, "User cancelled the question");
});

// ---------------------------------------------------------------------------
// pi-ask-user in the web host
// ---------------------------------------------------------------------------

function extension(path, tools, source) {
  return {
    path,
    tools: new Map(tools.map((name) => [name, {}])),
    sourceInfo: source ? { source } : undefined,
  };
}

test("Pi Web's ask_user replaces pi-ask-user's, and leaves other extensions alone", () => {
  const host = extension(ASK_USER_EXTENSION_PATH, [ASK_USER_TOOL_NAME]);
  const legacy = extension("/home/me/.pi/agent/npm/node_modules/pi-ask-user/index.ts", [ASK_USER_TOOL_NAME], "npm:pi-ask-user");
  const other = extension("/home/me/ext/other.ts", [ASK_USER_TOOL_NAME], "npm:other-tools");
  const unrelated = extension("/home/me/ext/keep.ts", ["keep_me"], "npm:other-tools");
  const base = {
    extensions: [legacy, other, unrelated, host],
    errors: [
      { path: ASK_USER_EXTENSION_PATH, error: `Tool "${ASK_USER_TOOL_NAME}" conflicts with ${legacy.path}` },
      { path: "/home/me/ext/keep.ts", error: "unrelated problem" },
    ],
    warnings: [],
    runtime: {},
  };

  const preferred = preferPiWebAskUserExtension(base);
  assert.deepEqual(preferred.extensions.map((entry) => entry.path), [other.path, unrelated.path, host.path]);
  assert.deepEqual(preferred.errors, [{ path: "/home/me/ext/keep.ts", error: "unrelated problem" }]);
});

test("without the host extension, nothing is dropped", () => {
  const legacy = extension("/home/me/.pi/agent/npm/node_modules/pi-ask-user/index.ts", [ASK_USER_TOOL_NAME], "npm:pi-ask-user");
  const base = { extensions: [legacy], errors: [], warnings: [], runtime: {} };
  assert.equal(preferPiWebAskUserExtension(base), base);
});
