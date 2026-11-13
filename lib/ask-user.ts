import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type InlineExtension,
  type LoadExtensionsResult,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { readRegularFileText } from "./regular-file";
import { ASK_USER_TOOL_NAME } from "./types";
import type {
  AskUserAnswer,
  AskUserBatchDetails,
  AskUserOption,
  AskUserQuestion,
  AskUserToolDetails,
} from "./types";

export { ASK_USER_TOOL_NAME };

/**
 * Pi Web's own `ask_user` tool (#ask-user). The pi-ask-user package registers a
 * TUI component this host could only show as terminal lines; Pi Web registers the
 * same tool natively, draws the questions in the chat (components/AskUserDialog.tsx),
 * and keeps pi-ask-user's answer shape so its skill, its prompt guidelines, and
 * the transcripts it already wrote keep working.
 *
 * The tool does not reach the browser itself: `AgentSessionWrapper.askUser()` sends
 * the request over the session's event stream and waits for the answer command
 * (lib/rpc-manager.ts), so the run is parked exactly like an extension dialog.
 */

/** The host extension's name, its `<inline:...>` path, and pi-ask-user's package name. */
export const ASK_USER_EXTENSION_NAME = "pi-web-ask-user";
export const ASK_USER_EXTENSION_PATH = `<inline:${ASK_USER_EXTENSION_NAME}>`;
const PI_ASK_USER_PACKAGE_NAME = "pi-ask-user";

const BATCH_MIN_QUESTIONS = 2;
const BATCH_MAX_QUESTIONS = 4;
/** Single-question fields a batch sets per entry instead of at the top level. */
const BATCH_ENTRY_FIELDS = ["context", "options", "allowMultiple", "allowFreeform"] as const;
/** Keys models fall back to when a provider proxy strips the option shape. */
const OPTION_TITLE_KEYS = ["title", "label", "text", "value", "name", "option"] as const;

const ASK_USER_TOOL_EXPOSURE = "model-only" satisfies ToolExposure;

// ---------------------------------------------------------------------------
// Wire types between the tool and the browser
// ---------------------------------------------------------------------------

/** One question the browser shows; `lib/types.ts` has the request the client reads. */
export type AskUserResponse =
  | { kind: "selection"; selections: string[]; comment?: string }
  | { kind: "freeform"; text: string };

export interface AskUserPromptRequest {
  /** The model's top-level `question` beside a `questions` batch. */
  heading?: string;
  questions: AskUserQuestion[];
  allowComment: boolean;
  contextExpanded: boolean;
  expiresAt?: number;
}

/** What the browser answered: one answer per question, or the prompt went away. */
export type AskUserPromptOutcome =
  | { kind: "answered"; answers: AskUserAnswer[] }
  | { kind: "cancelled" };

/** How the tool reaches the session that owns the event stream. */
export type AskUserHost = (
  request: AskUserPromptRequest,
  signal?: AbortSignal,
) => Promise<AskUserPromptOutcome>;

// ---------------------------------------------------------------------------
// User preferences (~/.pi/agent/ask-user.json, PI_ASK_USER_*)
// ---------------------------------------------------------------------------

export interface AskUserSettings {
  allowComment?: boolean;
  contextExpanded?: boolean;
}

export function getAskUserSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "ask-user.json");
}

/**
 * The user-level preferences pi-ask-user reads, from `<agent-dir>/ask-user.json`.
 * The terminal-only keys it also stores (displayMode, layouts, shortcuts) have no
 * meaning in the chat and are ignored. A missing file yields `{}`; a file that
 * exists but is not valid JSON throws with its path, since silently ignoring a
 * hand-written settings file would hide the mistake.
 */
export function loadAskUserSettings(filePath = getAskUserSettingsPath()): AskUserSettings {
  const raw = readRegularFileText(filePath);
  if (raw === undefined) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    throw new Error(
      `Failed to parse ask-user settings at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const source = parsed as Record<string, unknown>;
  const settings: AskUserSettings = {};
  if (typeof source.allowComment === "boolean") settings.allowComment = source.allowComment;
  if (typeof source.contextExpanded === "boolean") settings.contextExpanded = source.contextExpanded;
  return settings;
}

export function parseBooleanPreference(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

export interface AskUserDefaults {
  allowComment: boolean;
  contextExpanded: boolean;
}

/** Environment first, then the settings file, then the built-in defaults. */
export function resolveAskUserDefaults(
  environment: NodeJS.ProcessEnv = process.env,
  settings: AskUserSettings = loadAskUserSettings(),
): AskUserDefaults {
  return {
    allowComment: parseBooleanPreference(environment.PI_ASK_USER_ALLOW_COMMENT) ?? settings.allowComment ?? false,
    contextExpanded:
      parseBooleanPreference(environment.PI_ASK_USER_CONTEXT_EXPANDED) ?? settings.contextExpanded ?? false,
  };
}

// ---------------------------------------------------------------------------
// Tool arguments
// ---------------------------------------------------------------------------

/** An option as models send it: nearly always `{title, description?}`, sometimes a plain string. */
export function coerceAskUserOption(option: unknown): AskUserOption | null {
  if (typeof option === "string" || typeof option === "number" || typeof option === "boolean") {
    const title = String(option).trim();
    return title ? { title } : null;
  }
  if (option && typeof option === "object") {
    const record = option as Record<string, unknown>;
    for (const key of OPTION_TITLE_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        const description = typeof record.description === "string" && record.description.trim()
          ? record.description
          : undefined;
        return description ? { title: value.trim(), description } : { title: value.trim() };
      }
    }
  }
  return null;
}

function malformedOptionsError(count: number, label?: string): Error {
  return new Error(
    `All ${count} option(s)${label ? ` in ${label}` : ""} were malformed, so nothing could be shown to the user. `
    + `Each option must be a plain string or an object like { "title": "Short label", "description": "Optional detail" }. `
    + `Call ask_user again with corrected options.`,
  );
}

function coerceOptions(raw: unknown, label?: string): AskUserOption[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${label ? `${label}.options` : "options"} must be an array.`);
  const options = raw.map(coerceAskUserOption).filter((option): option is AskUserOption => option !== null);
  if (raw.length > 0 && options.length === 0) throw malformedOptionsError(raw.length, label);
  return options;
}

export type NormalizedAsk =
  | { kind: "single"; question: AskUserQuestion }
  | { kind: "batch"; heading?: string; questions: AskUserQuestion[] };

export interface AskUserCallOptions {
  allowComment: boolean;
  contextExpanded: boolean;
  timeout?: number;
}

/**
 * A top-level question sent with `questions` is the batch's heading, not another
 * question. Every problem throws before a request reaches the browser, with the
 * message pi-ask-user gives the model so it can correct the call.
 */
export function normalizeAskUserParams(
  params: Record<string, unknown>,
  defaults: AskUserDefaults = resolveAskUserDefaults(),
): { ask: NormalizedAsk; options: AskUserCallOptions } {
  const allowComment = typeof params.allowComment === "boolean" ? params.allowComment : defaults.allowComment;
  const contextExpanded = typeof params.contextExpanded === "boolean" ? params.contextExpanded : defaults.contextExpanded;
  const timeout = typeof params.timeout === "number" && Number.isFinite(params.timeout) && params.timeout > 0
    ? params.timeout
    : undefined;
  const options: AskUserCallOptions = { allowComment, contextExpanded, ...(timeout ? { timeout } : {}) };

  if (params.questions != null) {
    const misplaced = BATCH_ENTRY_FIELDS.filter((field) => params[field] != null);
    if (misplaced.length > 0) {
      throw new Error(
        `${misplaced.join(", ")} cannot be set at the top level together with questions. Set them on each questions entry instead.`,
      );
    }
    if (!Array.isArray(params.questions)) {
      throw new Error(`questions must be an array of ${BATCH_MIN_QUESTIONS}-${BATCH_MAX_QUESTIONS} question objects.`);
    }
    if (params.questions.length < BATCH_MIN_QUESTIONS) {
      throw new Error(
        `questions needs ${BATCH_MIN_QUESTIONS}-${BATCH_MAX_QUESTIONS} entries but got ${params.questions.length}. To ask one question, use question instead.`,
      );
    }
    if (params.questions.length > BATCH_MAX_QUESTIONS) {
      throw new Error(
        `questions accepts at most ${BATCH_MAX_QUESTIONS} entries but got ${params.questions.length}. Ask the rest in a later ask_user call.`,
      );
    }

    const seen = new Set<string>();
    const questions = params.questions.map((entry, index): AskUserQuestion => {
      const label = `questions[${index}]`;
      const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      const question = typeof record.question === "string" ? record.question.trim() : "";
      if (!question) throw new Error(`${label}.question must be a non-empty string.`);
      const key = question.toLowerCase();
      if (seen.has(key)) {
        throw new Error(`${label} repeats the question "${question}". Each question in a batch must be distinct.`);
      }
      seen.add(key);

      return {
        question,
        ...(typeof record.context === "string" && record.context.trim() ? { context: record.context.trim() } : {}),
        options: coerceOptions(record.options, label),
        allowMultiple: record.allowMultiple === true,
        allowFreeform: record.allowFreeform !== false,
      };
    });

    const heading = typeof params.question === "string" && params.question.trim() ? params.question.trim() : undefined;
    return { ask: { kind: "batch", ...(heading ? { heading } : {}), questions }, options };
  }

  if (typeof params.question !== "string" || !params.question.trim()) {
    throw new Error("ask_user needs question (one focused question) or questions (2-4 independent questions).");
  }
  const question = params.question.trim();
  return {
    ask: {
      kind: "single",
      question: {
        question,
        ...(typeof params.context === "string" && params.context.trim() ? { context: params.context.trim() } : {}),
        options: coerceOptions(params.options),
        allowMultiple: params.allowMultiple === true,
        allowFreeform: params.allowFreeform !== false,
      },
    },
    options,
  };
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Trims what the browser sent and drops a selection of no option or an empty freeform text. */
function cleanAnswer(answer: AskUserAnswer, question: AskUserQuestion): AskUserAnswer | null {
  if (answer.kind === "skipped") return answer;
  if (answer.kind === "freeform") {
    // The chat offers the field for every question without options, and otherwise as the model asked.
    if (!question.allowFreeform && question.options.length > 0) return null;
    const text = answer.text.trim();
    return text ? { kind: "freeform", text } : null;
  }
  if (answer.kind !== "selection") return null;
  const offered = new Set(question.options.map((option) => option.title));
  const selections = [...new Set(answer.selections.map((selection) => selection.trim()).filter(Boolean))];
  if (selections.length === 0 || selections.some((selection) => !offered.has(selection))) return null;
  if (!question.allowMultiple && selections.length > 1) return null;
  const comment = typeof answer.comment === "string" ? answer.comment.trim() : "";
  return comment
    ? { kind: "selection", selections, comment }
    : { kind: "selection", selections };
}

/**
 * Validates a browser answer against the questions it was asked. The browser
 * checks too; this is the boundary that keeps a malformed or replayed command
 * from turning into a tool result the model would read as a person's words.
 */
export function parseAskUserAnswers(raw: unknown, questions: readonly AskUserQuestion[]): AskUserAnswer[] {
  if (!Array.isArray(raw) || raw.length !== questions.length) {
    throw new Error(`ask_user needs ${questions.length} answer(s)`);
  }
  return raw.map((entry, index) => {
    const question = questions[index]!;
    if (!entry || typeof entry !== "object") throw new Error(`ask_user answer ${index + 1} is invalid`);
    const answer = entry as AskUserAnswer;
    if (answer.kind === "skipped" && questions.length === 1) {
      throw new Error("ask_user needs an answer to the question");
    }
    const clean = cleanAnswer(answer, question);
    if (!clean) throw new Error(`ask_user answer ${index + 1} is not one of the offered answers`);
    return clean;
  });
}

function isSelectionResponse(
  response: AskUserResponse,
): response is Extract<AskUserResponse, { kind: "selection" }> {
  return response.kind === "selection";
}

function answeredResponse(answer: AskUserAnswer | undefined): AskUserResponse | null {
  if (!answer || answer.kind === "skipped") return null;
  return isSelectionResponse(answer)
    ? answer.comment
      ? { kind: "selection", selections: answer.selections, comment: answer.comment }
      : { kind: "selection", selections: answer.selections }
    : { kind: "freeform", text: answer.text };
}

export function formatAskUserResponseSummary(response: AskUserResponse): string {
  if (response.kind === "freeform") return response.text;
  const selections = response.selections.join(", ");
  return response.comment ? `${selections} — ${response.comment}` : selections;
}

/** The tool result the browser renders (components/AskUserCard.tsx) and the model reads. */
export function formatAskUserResult(
  ask: NormalizedAsk,
  outcome: AskUserPromptOutcome,
): { content: Array<{ type: "text"; text: string }>; details: AskUserToolDetails | AskUserBatchDetails } {
  if (ask.kind === "single") {
    const question = ask.question;
    const response = outcome.kind === "answered" ? answeredResponse(outcome.answers[0]) : null;
    const details: AskUserToolDetails = {
      question: question.question,
      ...(question.context ? { context: question.context } : {}),
      options: question.options,
      response,
      cancelled: response === null,
    };
    return {
      content: [{
        type: "text",
        text: response ? `User answered: ${formatAskUserResponseSummary(response)}` : "User cancelled the question",
      }],
      details,
    };
  }

  const questions = ask.questions;
  if (outcome.kind === "cancelled") {
    return {
      content: [{ type: "text", text: "User cancelled the questions" }],
      details: {
        kind: "batch",
        ...(ask.heading ? { heading: ask.heading } : {}),
        questions: questions.map(subjectOf),
        answers: [],
        cancelled: true,
      },
    };
  }

  const answers = outcome.answers.map((answer) => {
    const response = answeredResponse(answer);
    return response ? { status: "answered" as const, response } : { status: "skipped" as const };
  });
  const lines = questions.map((question, index) => {
    const answer = answers[index]!;
    const summary = answer.status === "answered" ? formatAskUserResponseSummary(answer.response) : "(skipped)";
    return `${index + 1}. ${question.question} → ${summary}`;
  });
  const answered = answers.filter((answer) => answer.status === "answered").length;
  const heading = ask.heading ? [ask.heading] : [];
  return {
    content: [{
      type: "text",
      text: [...heading, `User answered ${answered} of ${questions.length} questions:`, ...lines].join("\n"),
    }],
    details: {
      kind: "batch",
      ...(ask.heading ? { heading: ask.heading } : {}),
      questions: questions.map(subjectOf),
      answers,
      cancelled: false,
    },
  };
}

function subjectOf(question: AskUserQuestion): { question: string; context?: string; options: AskUserOption[] } {
  return {
    question: question.question,
    ...(question.context ? { context: question.context } : {}),
    options: question.options,
  };
}

/** What the tool card shows while no answer exists yet. */
export function pendingAskUserDetails(ask: NormalizedAsk): AskUserToolDetails | AskUserBatchDetails {
  if (ask.kind === "single") {
    return {
      ...subjectOf(ask.question),
      response: null,
      cancelled: false,
    };
  }
  return {
    kind: "batch",
    ...(ask.heading ? { heading: ask.heading } : {}),
    questions: ask.questions.map(subjectOf),
    answers: [],
    cancelled: false,
  };
}

/** The result of a call that never reached the browser, or one nothing answered. */
export function cancelledAskUserResult(ask: NormalizedAsk): ReturnType<typeof formatAskUserResult> {
  return formatAskUserResult(ask, { kind: "cancelled" });
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

const OPTION_PARAMETER = Type.Object({
  title: Type.String({ description: "Short title for this option" }),
  description: Type.Optional(
    Type.String({ description: "Longer description explaining this option" }),
  ),
});

export function askUserToolDefinition(host: AskUserHost) {
  return defineTool({
    name: ASK_USER_TOOL_NAME,
    label: "Ask User",
    description:
      "Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. Ask one focused question per call, or 2-4 independent questions together through questions. Before calling, gather context with tools (read/web/ref) and pass a short summary via the context field.",
    promptSnippet:
      "Ask the user one focused question (or 2-4 independent ones together) with optional multiple-choice answers to gather information interactively",
    promptGuidelines: [
      "Before calling ask_user, gather context with tools (read/web/ref) and pass a short summary via the context field.",
      "Use ask_user when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
      "Ask one focused question per ask_user call by default.",
      "Use questions (2-4 entries) only for independent decisions whose prerequisites are already settled; ask anything that depends on another answer in a later ask_user call.",
      "With questions, put every question inside questions. A top-level question is only shown as the batch heading and is never asked or answered.",
      "Do not combine multiple numbered, multipart, or unrelated questions into one question's text.",
    ],
    exposure: ASK_USER_TOOL_EXPOSURE,
    // Block other tool calls in the same assistant turn until the user answers,
    // so the model can't batch ask_user with bash/edit/write and let those run
    // (potentially with side effects) before the user sees the prompt.
    executionMode: "sequential",
    parameters: Type.Object({
      question: Type.Optional(
        Type.String({ description: "The question to ask the user. With questions, it is only an optional heading for the batch; put every actual question inside questions." }),
      ),
      questions: Type.Optional(
        Type.Array(
          Type.Object({
            question: Type.String({ description: "One question in the batch" }),
            context: Type.Optional(
              Type.String({ description: "Relevant context to show with this question (summary of findings)" }),
            ),
            options: Type.Optional(
              Type.Array(OPTION_PARAMETER, { description: "List of options for this question" }),
            ),
            allowMultiple: Type.Optional(
              Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
            ),
            allowFreeform: Type.Optional(
              Type.Boolean({ description: "Add a freeform text field. Default: true" }),
            ),
          }),
          {
            minItems: BATCH_MIN_QUESTIONS,
            maxItems: BATCH_MAX_QUESTIONS,
            description: "2-4 independent questions shown together, used instead of question. Set context, options, allowMultiple, and allowFreeform on each entry; the remaining parameters apply to the whole batch.",
          },
        ),
      ),
      context: Type.Optional(
        Type.String({
          description: "Relevant context to show before the question (summary of findings)",
        }),
      ),
      options: Type.Optional(
        Type.Array(OPTION_PARAMETER, { description: "List of options for the user to choose from" }),
      ),
      allowMultiple: Type.Optional(
        Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
      ),
      allowFreeform: Type.Optional(
        Type.Boolean({ description: "Add a freeform text field. Default: true" }),
      ),
      allowComment: Type.Optional(
        Type.Boolean({ description: "Collect an optional comment after selecting one or more options. Default: PI_ASK_USER_ALLOW_COMMENT env var or allowComment in ~/.pi/agent/ask-user.json if set, otherwise false." }),
      ),
      contextExpanded: Type.Optional(
        Type.Boolean({ description: "Show long context expanded instead of collapsed behind its summary. Default: PI_ASK_USER_CONTEXT_EXPANDED env var or contextExpanded in ~/.pi/agent/ask-user.json if set, otherwise false." }),
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Auto-dismiss after N milliseconds. Returns null (cancelled) when expired." }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const { ask, options } = normalizeAskUserParams(params as Record<string, unknown>);
      if (signal?.aborted) return cancelledAskUserResult(ask);

      onUpdate?.({
        content: [{ type: "text", text: "Waiting for user input..." }],
        details: pendingAskUserDetails(ask),
      });

      const expiresAt = options.timeout ? Date.now() + options.timeout : undefined;
      const outcome = await host({
        ...(ask.kind === "batch" && ask.heading ? { heading: ask.heading } : {}),
        questions: askQuestions(ask),
        allowComment: options.allowComment,
        contextExpanded: options.contextExpanded,
        ...(expiresAt ? { expiresAt } : {}),
      }, signal);

      return formatAskUserResult(ask, signal?.aborted ? { kind: "cancelled" } : outcome);
    },
  });
}

function askQuestions(ask: NormalizedAsk): AskUserQuestion[] {
  return ask.kind === "single" ? [ask.question] : ask.questions;
}

/** The `ask_user` tool, as an inline extension for a normal Pi Web session. */
export function createAskUserExtension(host: AskUserHost): InlineExtension {
  return {
    name: ASK_USER_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.registerTool(askUserToolDefinition(host));
    },
  };
}

// ---------------------------------------------------------------------------
// pi-ask-user in the web host
// ---------------------------------------------------------------------------

function isPiAskUserExtension(extension: LoadExtensionsResult["extensions"][number]): boolean {
  const source = extension.sourceInfo?.source ?? "";
  const sourcePackage = source.replace(/^npm:/, "").split("@")[0];
  const pathSegments = extension.path.replaceAll("\\", "/").split("/");
  return sourcePackage === PI_ASK_USER_PACKAGE_NAME
    || pathSegments.some((segment) => segment === PI_ASK_USER_PACKAGE_NAME);
}

/**
 * Pi Web absorbs pi-ask-user: its `ask_user` renders as terminal lines through
 * `ctx.ui.custom()`, which this host can only show as a text panel, while the tool
 * Pi Web registers draws the questions in the chat. A session that has the
 * package installed therefore drops its extension (the package registers nothing
 * else) and keeps Pi Web's tool; the package's skill, and any other extension,
 * stay. Only the known package is dropped, so a third-party `ask_user` keeps the
 * tool in the CLI's load order.
 */
export function preferPiWebAskUserExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const host = base.extensions.find(
    (extension) => extension.path === ASK_USER_EXTENSION_PATH && extension.tools.has(ASK_USER_TOOL_NAME),
  );
  if (!host) return base;

  const replacedPaths = new Set(base.extensions
    .filter((extension) => extension.path !== ASK_USER_EXTENSION_PATH)
    .filter((extension) => extension.tools.has(ASK_USER_TOOL_NAME))
    .filter(isPiAskUserExtension)
    .map((extension) => extension.path));
  if (replacedPaths.size === 0) return base;

  return {
    ...base,
    extensions: base.extensions.filter((extension) => !replacedPaths.has(extension.path)),
    errors: base.errors.filter((error) => {
      if (replacedPaths.has(error.path)) return false;
      // The host loaded last, so the collision was recorded against it.
      return !(error.path === ASK_USER_EXTENSION_PATH
        && [...replacedPaths].some((replacedPath) =>
          error.error === `Tool "${ASK_USER_TOOL_NAME}" conflicts with ${replacedPath}`
        ));
    }),
  };
}
