import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  areAskQuestionsAnswered,
  askUserRequestSummary,
  buildAskUserAnswers,
  emptyAskUserDraft,
  isAskQuestionAnswered,
  readAskUserCard,
} = await jiti.import("./ask-user-ui.ts");

const PICK = {
  question: "Pick a colour",
  options: [{ title: "Red" }, { title: "Blue", description: "the logo" }],
  allowMultiple: false,
  allowFreeform: true,
};
const PICK_MANY = {
  question: "Pick themes",
  options: [{ title: "Light" }, { title: "Dark" }],
  allowMultiple: true,
  allowFreeform: true,
};
const WRITE = { question: "Anything else?", options: [], allowMultiple: false, allowFreeform: true };

test("a question is answered by an option or by text, and a written answer wins", () => {
  const empty = emptyAskUserDraft();
  assert.equal(isAskQuestionAnswered(PICK, empty), false);
  assert.equal(isAskQuestionAnswered(WRITE, empty), false);
  assert.equal(isAskQuestionAnswered(PICK, { ...empty, selections: ["Red"] }), true);
  assert.equal(isAskQuestionAnswered(WRITE, { ...empty, text: "Ship it" }), true);
  // Options stay checked while a custom answer is typed; the text is still the answer.
  assert.equal(areAskQuestionsAnswered([PICK, WRITE], [
    { ...empty, selections: ["Blue"], text: "Teal" },
    { ...empty, text: "No" },
  ]), true);
  assert.equal(areAskQuestionsAnswered([PICK, WRITE], [{ ...empty, selections: ["Blue"] }, empty]), false);
});

test("a draft becomes the same answer shape pi-ask-user recorded", () => {
  const answers = buildAskUserAnswers([PICK, PICK_MANY, WRITE], [
    { selections: ["Blue"], text: "  ", comment: " matches the logo " },
    { selections: ["Dark"], text: "Teal", comment: "ignored with a custom answer" },
    { selections: [], text: "  Ship it  ", comment: "" },
  ]);
  assert.deepEqual(answers, [
    { kind: "selection", selections: ["Blue"], comment: "matches the logo" },
    { kind: "freeform", text: "Teal" },
    { kind: "freeform", text: "Ship it" },
  ]);

  // Single-select keeps one option even if two were checked before allowMultiple changed.
  assert.deepEqual(
    buildAskUserAnswers([PICK], [{ selections: ["Red", "Blue"], text: "", comment: "" }]),
    [{ kind: "selection", selections: ["Red"] }],
  );
  assert.throws(
    () => buildAskUserAnswers([PICK], [{ selections: ["Green"], text: "", comment: "" }]),
    /needs an option or a written answer/,
  );
});

test("the summary names the batch heading first", () => {
  assert.equal(
    askUserRequestSummary({ heading: "  Two   things  ", questions: [PICK] }),
    "Two things",
  );
  assert.equal(askUserRequestSummary({ questions: [{ ...PICK, question: "  Pick\n one  " }] }), "Pick one");
  assert.equal(askUserRequestSummary({ questions: [] }), "");
});

test("a stored single-question result reads as a card", () => {
  const card = readAskUserCard({}, {
    question: "Pick a colour",
    options: [{ title: "Red" }, { title: "Blue", description: "the logo" }],
    response: { kind: "selection", selections: ["Blue"], comment: "matches the logo" },
    cancelled: false,
  });
  assert.equal(card.total, 1);
  assert.equal(card.answeredCount, 1);
  assert.equal(card.waiting, false);
  assert.equal(card.cancelled, false);
  assert.deepEqual(card.questions[0].options.map((option) => [option.title, option.selected]), [
    ["Red", false],
    ["Blue", true],
  ]);
  assert.deepEqual(card.questions[0].answer, {
    text: "Blue",
    freeform: false,
    selections: ["Blue"],
    comment: "matches the logo",
  });
});

test("a freeform answer keeps its own text", () => {
  const card = readAskUserCard({}, {
    question: "Anything else?",
    options: [],
    response: { kind: "freeform", text: "Ship it Friday" },
    cancelled: false,
  });
  assert.equal(card.answeredCount, 1);
  assert.equal(card.questions[0].answer.freeform, true);
  assert.equal(card.questions[0].answer.text, "Ship it Friday");
});

test("a batch result marks each question, including skipped ones", () => {
  const card = readAskUserCard({}, {
    kind: "batch",
    heading: "Setup",
    questions: [
      { question: "Database?", options: [{ title: "Postgres" }, { title: "SQLite" }] },
      { question: "Port?" },
      { question: "Telemetry?" },
    ],
    answers: [
      { status: "answered", response: { kind: "selection", selections: ["SQLite"] } },
      { status: "answered", response: { kind: "freeform", text: "3000" } },
      { status: "skipped" },
    ],
    cancelled: false,
  });
  assert.equal(card.heading, "Setup");
  assert.deepEqual(card.questions.map((question) => [question.answer?.text, question.skipped ?? false]), [
    ["SQLite", false],
    ["3000", false],
    [undefined, true],
  ]);
  assert.equal(card.summary, "Setup");
});

test("an unanswered call reads its questions from the tool arguments", () => {
  const card = readAskUserCard({
    question: "Which database?",
    context: "The app uses SQL.",
    options: [{ title: "Postgres" }, { title: "SQLite" }],
  }, undefined);
  assert.equal(card.waiting, true);
  assert.equal(card.questions[0].context, "The app uses SQL.");
  assert.equal(card.questions[0].options.length, 2);

  const batch = readAskUserCard({
    question: "Setup",
    questions: [{ question: "Database?", options: ["Postgres"] }, { question: "Port?" }],
  }, undefined);
  assert.equal(batch.heading, "Setup");
  assert.equal(batch.total, 2);
  assert.equal(batch.waiting, true);
});

test("a cancelled or error call never reads as JSON", () => {
  const cancelled = readAskUserCard({ question: "Go?", options: ["Yes", "No"] }, {
    question: "Go?",
    options: [{ title: "Yes" }, { title: "No" }],
    response: null,
    cancelled: true,
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.waiting, false);

  const errored = readAskUserCard({ question: "Go?", options: ["Yes"] }, undefined);
  assert.equal(errored.waiting, true);
  assert.equal(readAskUserCard({}, "not details"), null);
});
