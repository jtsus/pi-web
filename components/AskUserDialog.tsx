"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  areAskQuestionsAnswered,
  askUserRequestSummary,
  buildAskUserAnswers,
  emptyAskUserDraft,
  isAskQuestionAnswered,
  type AskUserDraft,
} from "@/lib/ask-user-ui";
import type { AskUserAnswer, AskUserOption, AskUserQuestion, AskUserRequestEvent } from "@/lib/types";

/**
 * Pi Web's ask_user prompt: the model's question, its options, and a field for
 * the user's own answer, drawn in the chat instead of the terminal lines an
 * extension's `ctx.ui.custom()` would produce. A centered dialog on a desktop
 * and a bottom sheet on a phone (app/globals.css, .ask-user-*).
 *
 * Every question of a batch is on one page, so the independent decisions the
 * model sent together stay together. The answer is only sent when each question
 * has an option or a written answer; Escape folds the sheet to a bar so the
 * transcript stays readable.
 */
export function AskUserDialog({
  request,
  waitingCount,
  onSubmit,
}: {
  request: AskUserRequestEvent;
  /** Further questions queued behind this one. */
  waitingCount: number;
  onSubmit: (
    request: AskUserRequestEvent,
    response: { answers: AskUserAnswer[] } | { cancelled: true },
  ) => Promise<void>;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [drafts, setDrafts] = useState<AskUserDraft[]>(() => request.questions.map(() => emptyAskUserDraft()));
  const [minimized, setMinimized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const panelRef = useRef<HTMLDivElement>(null);
  const summary = askUserRequestSummary(request);
  const allAnswered = areAskQuestionsAnswered(request.questions, drafts);
  const answeredCount = request.questions.filter((question, index) => isAskQuestionAnswered(question, drafts[index])).length;
  const isBatch = request.questions.length > 1;
  // A phone gets no focus on mount: it would open the software keyboard before
  // the question is even read.
  useEffect(() => {
    if (isMobile) return;
    const target = panelRef.current?.querySelector<HTMLElement>("[data-ask-user-autofocus]");
    (target ?? panelRef.current)?.focus();
  }, [isMobile]);

  // Escape folds or reopens the sheet wherever the focus is, and it is handled
  // here first so the global shortcut does not read it as "stop the running
  // agent": the question is still parked, and Cancel is the way out.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (submitting) return;
      setMinimized((value) => !value);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [submitting]);

  useEffect(() => {
    if (request.expiresAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);
  const remainingSeconds = request.expiresAt === undefined
    ? null
    : Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  const updateDraft = useCallback((index: number, patch: Partial<AskUserDraft>) => {
    setDrafts((previous) => previous.map((draft, position) => position === index ? { ...draft, ...patch } : draft));
    setError(null);
  }, []);

  const toggleOption = useCallback((index: number, title: string) => {
    const question = request.questions[index];
    if (!question) return;
    setDrafts((previous) => previous.map((draft, position) => {
      if (position !== index) return draft;
      if (!question.allowMultiple) return { ...draft, selections: [title] };
      return {
        ...draft,
        selections: draft.selections.includes(title)
          ? draft.selections.filter((selection) => selection !== title)
          : [...draft.selections, title],
      };
    }));
    setError(null);
  }, [request.questions]);

  const submit = useCallback(async () => {
    if (!allAnswered || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(request, { answers: buildAskUserAnswers(request.questions, drafts) });
    } catch (submitError) {
      console.error("Failed to send ask_user answer:", submitError);
      setError(t("chat.askUserSendFailed"));
      setSubmitting(false);
    }
  }, [allAnswered, drafts, onSubmit, request, submitting, t]);

  const cancel = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(request, { cancelled: true });
    } catch (cancelError) {
      console.error("Failed to cancel ask_user question:", cancelError);
      setError(t("chat.askUserCancelFailed"));
      setSubmitting(false);
    }
  }, [onSubmit, request, submitting, t]);

  // Both answer-bearing fields and their labels are unique per question.
  const fieldId = (kind: string, index: number) => `ask-user-${request.id}-${kind}-${index}`;
  const customWins = request.questions.some(
    (question, index) => question.options.length > 0
      && (drafts[index]?.text.trim().length ?? 0) > 0
      && (drafts[index]?.selections.length ?? 0) > 0,
  );

  if (minimized) {
    return (
      <div className="ask-user-layer is-minimized">
        <button
          type="button"
          className="ask-user-minimized-bar"
          aria-expanded={false}
          onClick={() => setMinimized(false)}
        >
          <span className="ask-user-minimized-dot" aria-hidden="true" />
          <span className="ask-user-minimized-label">
            {isBatch ? t("chat.askUserEyebrowMany") : t("chat.askUserEyebrow")}
          </span>
          <span className="ask-user-minimized-question">{summary}</span>
          {waitingCount > 0 && (
            <span className="ask-user-minimized-more">{t("chat.askUserMoreWaiting", { count: waitingCount })}</span>
          )}
          <span className="ask-user-minimized-action">{t("chat.askUserAnswer")}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="ask-user-layer">
      <div
        ref={panelRef}
        className="ask-user-panel"
        role="dialog"
        aria-modal="true"
        aria-label={summary || t("chat.askUserEyebrow")}
        tabIndex={-1}
      >
        <div className="ask-user-handle" aria-hidden="true" />
        <header className="ask-user-head">
          <div className="ask-user-head-row">
            <div className="ask-user-head-text">
              <div className="ask-user-eyebrow">
                {isBatch ? t("chat.askUserEyebrowMany") : t("chat.askUserEyebrow")}
              </div>
              {isBatch && (
                <h2 className="ask-user-title">
                  {request.heading ?? t("chat.askUserCount", { count: request.questions.length })}
                </h2>
              )}
              <div className="ask-user-meta">
                {isBatch && (
                  <span>{t("chat.askUserAnsweredCount", { answered: answeredCount, total: request.questions.length })}</span>
                )}
                {waitingCount > 0 && <span>{t("chat.askUserMoreWaiting", { count: waitingCount })}</span>}
                {remainingSeconds !== null && (
                  <span className="ask-user-expiry">{t("chat.askUserExpiresIn", { seconds: remainingSeconds })}</span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="ask-user-icon-button"
              title={t("chat.askUserMinimize")}
              aria-label={t("chat.askUserMinimize")}
              onClick={() => setMinimized(true)}
              disabled={submitting}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6l4 4 4-4" />
              </svg>
            </button>
          </div>
          {isBatch && (
            <div className="ask-user-progress" aria-hidden="true">
              <span style={{ width: `${(answeredCount / Math.max(1, request.questions.length)) * 100}%` }} />
            </div>
          )}
        </header>

        <div className="ask-user-body">
          {request.questions.map((question, index) => (
            <QuestionBlock
              key={`${request.id}-${index}`}
              question={question}
              index={index}
              batch={isBatch}
              draft={drafts[index] ?? emptyAskUserDraft()}
              allowComment={request.allowComment}
              contextExpanded={request.contextExpanded}
              disabled={submitting}
              textId={fieldId("text", index)}
              commentId={fieldId("comment", index)}
              onChange={updateDraft}
              onToggleOption={toggleOption}
            />
          ))}
        </div>

        <footer className="ask-user-footer">
          {(error || customWins) && (
            <div className={error ? "ask-user-note is-error" : "ask-user-note"} role={error ? "alert" : undefined}>
              {error ?? t("chat.askUserCustomWins")}
            </div>
          )}
          <div className="ask-user-actions">
            <button
              type="button"
              className="ask-user-btn secondary"
              onClick={() => void cancel()}
              disabled={submitting}
            >
              {t("chat.askUserCancel")}
            </button>
            <button
              type="button"
              className="ask-user-btn primary"
              onClick={() => void submit()}
              disabled={!allAnswered || submitting}
            >
              {isBatch ? t("chat.askUserSubmitMany") : t("chat.askUserSubmit")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function QuestionBlock({
  question,
  index,
  batch,
  draft,
  allowComment,
  contextExpanded,
  disabled,
  textId,
  commentId,
  onChange,
  onToggleOption,
}: {
  question: AskUserQuestion;
  index: number;
  batch: boolean;
  draft: AskUserDraft;
  allowComment: boolean;
  contextExpanded: boolean;
  disabled: boolean;
  textId: string;
  commentId: string;
  onChange: (index: number, patch: Partial<AskUserDraft>) => void;
  onToggleOption: (index: number, title: string) => void;
}) {
  const { t } = useI18n();
  const hasOptions = question.options.length > 0;
  // A question without options is a written answer whatever allowFreeform says.
  const showFreeform = question.allowFreeform || !hasOptions;
  const customAnswer = draft.text.trim().length > 0;

  return (
    <section className="ask-user-question" aria-label={question.question}>
      <div className="ask-user-question-head">
        {batch && <span className="ask-user-qindex" aria-hidden="true">{index + 1}</span>}
        <div className="ask-user-question-text">{question.question}</div>
      </div>
      {question.context && (
        <AskUserContext text={question.context} expandedInitially={contextExpanded} />
      )}
      {hasOptions && (
        <div
          className="ask-user-options"
          role={question.allowMultiple ? "group" : "radiogroup"}
          aria-label={question.question}
        >
          {question.allowMultiple && <div className="ask-user-hint">{t("chat.askUserMultiHint")}</div>}
          {question.options.map((option, optionIndex) => (
            <OptionRow
              key={option.title}
              option={option}
              multiple={question.allowMultiple}
              checked={draft.selections.includes(option.title)}
              disabled={disabled}
              autoFocus={index === 0 && optionIndex === 0}
              onSelect={() => onToggleOption(index, option.title)}
            />
          ))}
        </div>
      )}
      {showFreeform && (
        <label className="ask-user-field" htmlFor={textId}>
          <span className="ask-user-field-label">
            {hasOptions ? t("chat.askUserOther") : t("chat.askUserYourAnswer")}
          </span>
          <textarea
            id={textId}
            className="ask-user-input"
            rows={hasOptions ? 2 : 3}
            value={draft.text}
            placeholder={t("chat.askUserInputPlaceholder")}
            disabled={disabled}
            onChange={(event) => onChange(index, { text: event.currentTarget.value })}
          />
        </label>
      )}
      {allowComment && hasOptions && !customAnswer && (
        <label className="ask-user-field is-comment" htmlFor={commentId}>
          <span className="ask-user-field-label">{t("chat.askUserComment")}</span>
          <textarea
            id={commentId}
            className="ask-user-input"
            rows={2}
            value={draft.comment}
            placeholder={t("chat.askUserCommentPlaceholder")}
            disabled={disabled}
            onChange={(event) => onChange(index, { comment: event.currentTarget.value })}
          />
        </label>
      )}
    </section>
  );
}

function OptionRow({
  option,
  multiple,
  checked,
  disabled,
  autoFocus,
  onSelect,
}: {
  option: AskUserOption;
  multiple: boolean;
  checked: boolean;
  disabled: boolean;
  autoFocus: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="ask-user-option"
      role={multiple ? "checkbox" : "radio"}
      aria-checked={checked}
      data-selected={checked ? "true" : undefined}
      disabled={disabled}
      onClick={onSelect}
      {...(autoFocus ? { "data-ask-user-autofocus": "true" } : {})}
    >
      <span className={multiple ? "ask-user-mark is-check" : "ask-user-mark is-radio"} aria-hidden="true">
        {checked && (multiple
          ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5 5.2 4 7.6 8.5 2.4" /></svg>
          : <span className="ask-user-mark-dot" />)}
      </span>
      <span className="ask-user-option-text">
        <span className="ask-user-option-title">{option.title}</span>
        {option.description && <span className="ask-user-option-description">{option.description}</span>}
      </span>
    </button>
  );
}

/** Model-provided context, folded when it would push the choices off a phone. */
function AskUserContext({ text, expandedInitially }: { text: string; expandedInitially: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(expandedInitially);
  const collapsible = useMemo(() => text.length > 320 || text.split("\n").length > 5, [text]);
  return (
    <div className="ask-user-context">
      <div className={collapsible && !expanded ? "ask-user-context-body is-clamped" : "ask-user-context-body"}>
        <MarkdownBody>{text}</MarkdownBody>
      </div>
      {collapsible && (
        <button type="button" className="ask-user-context-toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? t("chat.askUserShowLess") : t("chat.askUserShowMore")}
        </button>
      )}
    </div>
  );
}
