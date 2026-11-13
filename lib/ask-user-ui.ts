import type {
  AskUserAnswer,
  AskUserBatchDetails,
  AskUserOption,
  AskUserQuestion,
  AskUserRequestEvent,
  AskUserToolDetails,
} from "./types";

/**
 * Client-safe rules for Pi Web's ask_user: what counts as an answer, the command
 * a draft becomes, and how a stored result (this host's or pi-ask-user's) reads
 * as a tool card. Kept out of lib/ask-user.ts, which reads settings from disk.
 */

export interface AskUserDraft {
  /** Checked option titles. A non-empty `text` wins over them, as pi-ask-user's freeform did. */
  selections: string[];
  text: string;
  comment: string;
}

export function emptyAskUserDraft(): AskUserDraft {
  return { selections: [], text: "", comment: "" };
}

/** Every question needs an answer before the request can be sent. */
export function isAskQuestionAnswered(question: AskUserQuestion, draft: AskUserDraft | undefined): boolean {
  if (!draft) return false;
  if (draft.text.trim()) return true;
  if (question.options.length === 0) return false;
  return draft.selections.length > 0;
}

export function areAskQuestionsAnswered(
  questions: readonly AskUserQuestion[],
  drafts: ReadonlyArray<AskUserDraft | undefined>,
): boolean {
  return questions.every((question, index) => isAskQuestionAnswered(question, drafts[index]));
}

/**
 * A draft as the wire answer. A custom text is its own freeform answer and the
 * comment only belongs to a selection, exactly as pi-ask-user recorded them.
 */
export function buildAskUserAnswers(
  questions: readonly AskUserQuestion[],
  drafts: ReadonlyArray<AskUserDraft | undefined>,
): AskUserAnswer[] {
  return questions.map((question, index) => {
    const draft = drafts[index] ?? emptyAskUserDraft();
    const text = draft.text.trim();
    if (text) return { kind: "freeform", text };

    const offered = new Set(question.options.map((option) => option.title));
    const selections = [...new Set(draft.selections.filter((title) => offered.has(title)))];
    if (selections.length === 0) {
      throw new Error("Each question needs an option or a written answer.");
    }
    const comment = draft.comment.trim();
    return {
      kind: "selection",
      selections: question.allowMultiple ? selections : selections.slice(0, 1),
      ...(comment ? { comment } : {}),
    };
  });
}

/** The line a minimized request (and a browser notification) shows. */
export function askUserRequestSummary(request: Pick<AskUserRequestEvent, "heading" | "questions">): string {
  const heading = request.heading?.trim();
  if (heading) return heading.replace(/\s+/g, " ");
  return (request.questions[0]?.question ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Stored results, ours and pi-ask-user's, as a card
// ---------------------------------------------------------------------------

export interface AskUserCardOption {
  title: string;
  description?: string;
  selected: boolean;
}

export interface AskUserCardAnswer {
  text: string;
  /** A written answer, shown as the user's own words rather than an option. */
  freeform: boolean;
  /** The option titles a selection picked, so marking does not split the text. */
  selections?: string[];
  comment?: string;
}

export interface AskUserCardQuestion {
  question: string;
  context?: string;
  options: AskUserCardOption[];
  answer?: AskUserCardAnswer;
  skipped?: boolean;
  waiting?: boolean;
}

export interface AskUserCard {
  heading?: string;
  questions: AskUserCardQuestion[];
  /** The prompt went away unanswered (Cancel, timeout, Stop). */
  cancelled: boolean;
  /** No answer exists yet: the call is still running, or its details are a progress update. */
  waiting: boolean;
  answeredCount: number;
  total: number;
  /** One line for a collapsed tool card. */
  summary: string;
}

/** The option shape models send, including plain strings and common alias keys. */
function readOption(raw: unknown): AskUserOption | null {
  if (typeof raw === "string") {
    const title = raw.trim();
    return title ? { title } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  for (const key of ["title", "label", "text", "value", "name", "option"]) {
    const value = record[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const description = typeof record.description === "string" && record.description.trim()
      ? record.description
      : undefined;
    return description ? { title: value.trim(), description } : { title: value.trim() };
  }
  return null;
}

function readOptions(raw: unknown): AskUserOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(readOption).filter((option): option is AskUserOption => option !== null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectionAnswer(response: unknown): AskUserCardAnswer | undefined {
  if (!isRecord(response)) return undefined;
  if (response.kind === "freeform") {
    const text = typeof response.text === "string" ? response.text.trim() : "";
    return text ? { text, freeform: true } : undefined;
  }
  if (response.kind === "selection" && Array.isArray(response.selections)) {
    const selections = response.selections.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
    if (selections.length === 0) return undefined;
    const comment = typeof response.comment === "string" && response.comment.trim() ? response.comment.trim() : undefined;
    return { text: selections.join(", "), freeform: false, selections, ...(comment ? { comment } : {}) };
  }
  return undefined;
}

function questionOf(
  question: string,
  context: string | undefined,
  options: AskUserOption[],
  answered: { answer?: AskUserCardAnswer; skipped?: boolean; waiting?: boolean },
): AskUserCardQuestion {
  const selected = new Set(answered.answer?.selections ?? []);
  return {
    question,
    ...(context ? { context } : {}),
    options: options.map((option) => ({
      ...option,
      selected: selected.has(option.title),
    })),
    ...(answered.answer ? { answer: answered.answer } : {}),
    ...(answered.skipped ? { skipped: true } : {}),
    ...(answered.waiting ? { waiting: true } : {}),
  };
}

function cardFromDetails(details: unknown): AskUserCard | null {
  if (!isRecord(details)) return null;

  if (details.kind === "batch") {
    const batch = details as unknown as AskUserBatchDetails;
    if (!Array.isArray(batch.questions)) return null;
    const answers = Array.isArray(batch.answers) ? batch.answers : [];
    const questions = batch.questions.map((subject, index) => {
      const answer = answers[index];
      const response = answer && answer.status === "answered" ? selectionAnswer(answer.response) : undefined;
      return questionOf(subject.question, subject.context, readOptions(subject.options), {
        ...(response ? { answer: response } : {}),
        ...(answer?.status === "skipped" ? { skipped: true } : {}),
        ...(!answer && !batch.cancelled ? { waiting: true } : {}),
      });
    });
    return finishCard({
      ...(batch.heading ? { heading: batch.heading } : {}),
      questions,
      cancelled: batch.cancelled === true,
    });
  }

  if (typeof details.question !== "string") return null;
  const single = details as unknown as AskUserToolDetails;
  const response = selectionAnswer(single.response);
  const questions = [questionOf(single.question, single.context, readOptions(single.options), {
    ...(response ? { answer: response } : {}),
    ...(!single.cancelled && !response ? { waiting: true } : {}),
  })];
  return finishCard({
    questions,
    cancelled: single.cancelled === true,
  });
}

/** The tool call's arguments, while no result exists yet (or the result lost its details). */
function cardFromInput(input: unknown): AskUserCard | null {
  if (!isRecord(input)) return null;
  const heading = typeof input.question === "string" && input.question.trim() ? input.question.trim() : undefined;

  if (Array.isArray(input.questions)) {
    const entries = input.questions.filter(isRecord);
    if (entries.length === 0) return null;
    return finishCard({
      ...(heading ? { heading } : {}),
      questions: entries.map((entry) => questionOf(
        typeof entry.question === "string" ? entry.question.trim() : "",
        typeof entry.context === "string" && entry.context.trim() ? entry.context.trim() : undefined,
        readOptions(entry.options),
        { waiting: true },
      )),
      cancelled: false,
    });
  }

  if (typeof input.question !== "string" || !input.question.trim()) return null;
  return finishCard({
    questions: [questionOf(
      input.question.trim(),
      typeof input.context === "string" && input.context.trim() ? input.context.trim() : undefined,
      readOptions(input.options),
      { waiting: true },
    )],
    cancelled: false,
  });
}

function finishCard(card: Omit<AskUserCard, "answeredCount" | "total" | "waiting" | "summary">): AskUserCard {
  const total = card.questions.length;
  const answeredCount = card.questions.filter((question) => question.answer !== undefined).length;
  const waiting = !card.cancelled && card.questions.some((question) => question.waiting);
  return {
    ...card,
    total,
    answeredCount,
    waiting,
    summary: (card.heading ?? card.questions[0]?.question ?? "").replace(/\s+/g, " "),
  };
}

/**
 * How a tool card shows an ask_user call. `details` is the finished result; when
 * it is absent (the call is still running) or carries only this host's progress
 * snapshot, `input` supplies the questions so the card never falls back to JSON.
 * A result written by pi-ask-user parses here too.
 */
export function readAskUserCard(input: unknown, details: unknown): AskUserCard | null {
  return cardFromDetails(details) ?? cardFromInput(input);
}
