import { useEffect, useMemo, useRef } from "react";
import type { SessionEvent } from "../../api/session-events";
import { sessionEventsOf } from "../../api/session-events";
import type { StepRunStatus, StepRunWithLog } from "@issue-resolver/shared";
import type { ChatDraftApi } from "./chat-drafts";
import { isQuestionEligibleStatus } from "./status";
import type { QuestionEvent, StepRunsState } from "./types";
import { AsyncStateStatus } from '../../lib/async-state';

interface UseQuestionFeedInput {
  stepRuns: StepRunsState;
  liveEventsByRun: Record<string, SessionEvent[]>;
  liveStatusByRun: Record<string, StepRunStatus>;
  answeredQuestionIds: Set<string>;
  expandedEvents: SessionEvent[];
  chatDraft: ChatDraftApi;
  statusOf: (run: Pick<StepRunWithLog, "id" | "status">) => StepRunStatus;
  isActiveStatus: (status: StepRunStatus) => boolean;
}

export function useQuestionFeed({
  stepRuns,
  liveEventsByRun,
  liveStatusByRun,
  answeredQuestionIds,
  expandedEvents,
  chatDraft,
  statusOf,
  isActiveStatus,
}: UseQuestionFeedInput) {
  const lastScrolledRunRef = useRef<string | null>(null);

  const questionEvents = useMemo<QuestionEvent[]>(() => {
    if (stepRuns.status !== AsyncStateStatus.ready) return [];
    const seen = new Set<string>();
    const questions: QuestionEvent[] = [];
    for (const run of stepRuns.data) {
      if (!isQuestionEligibleStatus(statusOf(run))) continue;
      for (const event of [
        ...sessionEventsOf(run),
        ...(liveEventsByRun[run.id] ?? []),
      ]) {
        if (event.type === "question" && !seen.has(event.id)) {
          seen.add(event.id);
          questions.push(event);
        }
      }
    }
    return questions;
  }, [stepRuns, liveEventsByRun, liveStatusByRun]);

  const unansweredQuestions = useMemo(
    () =>
      questionEvents.filter(
        (question) => !answeredQuestionIds.has(question.id),
      ),
    [questionEvents, answeredQuestionIds],
  );

  useEffect(() => {
    if (unansweredQuestions.length > 0) return;
    if (stepRuns.status !== AsyncStateStatus.ready) return;
    const firstRunning = stepRuns.data.find((run) => {
      const status = statusOf(run);
      return isActiveStatus(status);
    });
    if (!firstRunning) {
      lastScrolledRunRef.current = null;
      return;
    }

    if (lastScrolledRunRef.current === firstRunning.id) return;
    lastScrolledRunRef.current = firstRunning.id;

    const timer = setTimeout(() => {
      const el = document.querySelector(
        `[data-step-run-id="${firstRunning.id}"]`,
      );
      if (el instanceof HTMLElement) {
        el.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [stepRuns, liveStatusByRun, unansweredQuestions]);

  const lastEditorText = useMemo(() => {
    let text: string | null = null;
    for (const event of expandedEvents) {
      if (event.type === "editor_text") text = event.text;
    }
    return text;
  }, [expandedEvents]);

  useEffect(() => {
    if (lastEditorText !== null) chatDraft.setText(lastEditorText);
  }, [lastEditorText]);

  return { questionEvents, unansweredQuestions };
}