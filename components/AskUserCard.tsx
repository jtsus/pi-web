"use client";

import { useI18n } from "@/hooks/useI18n";
import type { AskUserCard } from "@/lib/ask-user-ui";

/**
 * An ask_user call in the transcript: the questions, every option it offered,
 * the ones chosen, and a written answer or comment. pi-ask-user recorded the
 * same details, so results from sessions written before Pi Web drew the prompt
 * itself read the same way (lib/ask-user-ui.ts).
 */
export function AskUserCardBody({ card }: { card: AskUserCard }) {
  const { t } = useI18n();
  return (
    <div className="ask-user-card">
      {card.cancelled && <div className="ask-user-card-status is-cancelled">{t("chat.askUserCardCancelled")}</div>}
      {card.questions.map((question, index) => (
        <div key={index} className="ask-user-card-question">
          <div className="ask-user-card-question-row">
            {card.total > 1 && <span className="ask-user-qindex" aria-hidden="true">{index + 1}</span>}
            <span className="ask-user-card-question-text">{question.question}</span>
            {question.skipped && <span className="ask-user-card-status">{t("chat.askUserCardSkipped")}</span>}
          </div>
          {question.context && <div className="ask-user-card-context">{question.context}</div>}
          {question.options.length > 0 && (
            <ul className="ask-user-card-options">
              {question.options.map((option) => (
                <li key={option.title} className={option.selected ? "is-selected" : undefined}>
                  <span className="ask-user-mark is-radio" aria-hidden="true">
                    {option.selected && <span className="ask-user-mark-dot" />}
                  </span>
                  <span className="ask-user-option-text">
                    <span className="ask-user-option-title">{option.title}</span>
                    {option.description && <span className="ask-user-option-description">{option.description}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {question.answer?.freeform && (
            <div className="ask-user-card-answer">
              <span className="ask-user-card-label">{t("chat.askUserCardAnswer")}</span>
              <span className="ask-user-card-answer-text">{question.answer.text}</span>
            </div>
          )}
          {question.answer?.comment && (
            <div className="ask-user-card-answer is-comment">
              <span className="ask-user-card-label">{t("chat.askUserCardComment")}</span>
              <span className="ask-user-card-answer-text">{question.answer.comment}</span>
            </div>
          )}
        </div>
      ))}
      {card.waiting && (
        <div className="ask-user-card-status is-waiting">{t("chat.askUserCardWaiting")}</div>
      )}
    </div>
  );
}
