import { messageOf } from "../../lib/errors";
import { useEffect, useState } from "react";
import { getQuestionAnswers, sendUiResponse } from "../../api/client";
import type { QuestionEvent } from "./types";

export function useQuestionAnswer(
  activeIterationId: string | null,
  refreshTick: number,
) {
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [answeredQuestionIds, setAnsweredQuestionIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (!activeIterationId) return;
    let cancelled = false;
    getQuestionAnswers(activeIterationId)
      .then((ids) => {
        if (cancelled || !Array.isArray(ids) || ids.length === 0) return;
        setAnsweredQuestionIds((current) => {
          const next = new Set(current);
          for (const id of ids) next.add(id);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeIterationId, refreshTick]);

  function resetQuestions() {
    setQuestionSubmitting(false);
    setQuestionError(null);
    setAnsweredQuestionIds(new Set());
  }

  async function handleQuestionResponse(
    question: QuestionEvent,
    payload: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ) {
    if (!activeIterationId) return;
    setQuestionError(null);
    setQuestionSubmitting(true);

    try {
      await sendUiResponse(activeIterationId, {
        id: question.id,
        ...payload,
      });
    } catch (error) {
      setQuestionError(messageOf(error));
    } finally {
      setQuestionSubmitting(false);
      setAnsweredQuestionIds((current) => {
        const next = new Set(current);
        next.add(question.id);
        return next;
      });
    }
  }

  return {
    questionSubmitting,
    questionError,
    answeredQuestionIds,
    setAnsweredQuestionIds,
    resetQuestions,
    handleQuestionResponse,
  };
}