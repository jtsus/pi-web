import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { AskUserDialog } = await jiti.import("./AskUserDialog.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(AskUserDialog, { waitingCount: 0, onSubmit: async () => {}, ...props }),
    ),
  );
}

const SINGLE = {
  type: "ask_user_request",
  id: "ask-1",
  questions: [{
    question: "Pick a colour",
    context: "The header is blue today.",
    options: [{ title: "Red" }, { title: "Blue", description: "the logo" }],
    allowMultiple: false,
    allowFreeform: true,
  }],
  allowComment: true,
  contextExpanded: false,
};

test("a question draws its options, a field for a custom answer, and a disabled submit", () => {
  const html = render({ request: SINGLE });

  assert.match(html, /Agent question/);
  assert.match(html, /Pick a colour/);
  assert.match(html, /The header is blue today\./);
  assert.match(html, /Blue/);
  assert.match(html, /the logo/);
  assert.match(html, /role="radio"/);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /Or type your own answer/);
  assert.match(html, /Type your answer…/);
  assert.match(html, /Comment \(optional\)/);
  assert.match(html, /Send answer/);
  assert.match(html, /class="ask-user-btn primary" disabled=""/);
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
});

test("a phone sheet's markup keeps every question of a batch together", () => {
  const html = render({
    request: {
      type: "ask_user_request",
      id: "ask-2",
      heading: "Setup",
      questions: [
        {
          question: "Which database?",
          options: [{ title: "Postgres" }, { title: "SQLite" }],
          allowMultiple: false,
          allowFreeform: false,
        },
        { question: "Which port?", options: [], allowMultiple: false, allowFreeform: true },
      ],
      allowComment: false,
      contextExpanded: false,
    },
    waitingCount: 1,
  });

  assert.match(html, /Agent questions/);
  assert.match(html, /<h2 class="ask-user-title">Setup<\/h2>/);
  assert.match(html, /0 of 2 answered/);
  assert.match(html, /Which database\?/);
  assert.match(html, /Which port\?/);
  assert.match(html, /class="ask-user-qindex"/);
  assert.match(html, /Your answer/);
  assert.doesNotMatch(html, /Or type your own answer/);
  assert.match(html, /Send answers/);
  assert.match(html, /\+1 more waiting/);
  assert.doesNotMatch(html, /Comment \(optional\)/);
});

test("a timeout shows its countdown, and an expanded context skips the fold", () => {
  const longContext = "x".repeat(400);
  const html = render({
    request: {
      ...SINGLE,
      id: "ask-3",
      contextExpanded: true,
      expiresAt: Date.now() + 60_000,
      questions: [{ ...SINGLE.questions[0], context: longContext }],
    },
  });

  assert.match(html, /Closes in \d+s/);
  assert.match(html, /ask-user-context-body/);
  assert.doesNotMatch(html, /is-clamped/);
  assert.match(html, /Show less/);
});
