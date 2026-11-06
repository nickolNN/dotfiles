import { messageOf } from "../../lib/errors";
import { useState, type Dispatch, type SetStateAction } from "react";
import {
  TaskStatus,
  isIterationActive,
  type Iteration,
} from "@issue-resolver/shared";
import {
  abortIteration,
  fetchReviewComments,
  getIterations,
  queueIteration,
  repeatIteration,
  startIssue,
} from "../../api/client";
import type { IterationForm } from "./useIterationForm";
import { withIterations } from "./load-state";
import type { LoadState } from "./types";
import { AsyncStateStatus } from '../../lib/async-state';

interface UseIterationActionsInput {
  issueId: string | null | undefined;
  form: IterationForm;
  setState: Dispatch<SetStateAction<LoadState>>;
  setRefreshTick: Dispatch<SetStateAction<number>>;
  setSelectedIterationId: (id: string | null) => void;
}

export function useIterationActions({
  issueId,
  form,
  setState,
  setRefreshTick,
  setSelectedIterationId,
}: UseIterationActionsInput) {
  const [aborting, setAborting] = useState(false);
  const [abortError, setAbortError] = useState<string | null>(null);
  const [repeatingId, setRepeatingId] = useState<string | null>(null);
  const [repeatError, setRepeatError] = useState<string | null>(null);
  const [fetchingReviewId, setFetchingReviewId] = useState<string | null>(null);
  const [queueingId, setQueueingId] = useState<string | null>(null);
  const [fetchReviewError, setFetchReviewError] = useState<string | null>(null);
  const [fetchReviewMessage, setFetchReviewMessage] = useState<string | null>(
    null,
  );
  const [startingDraft, setStartingDraft] = useState(false);
  const [startDraftError, setStartDraftError] = useState<string | null>(null);

  function replaceIterations(iterations: Iteration[]) {
    setState((current) => withIterations(current, iterations));
  }

  async function handleAbort(iterationId: string) {
    setAbortError(null);
    setAborting(true);

    try {
      await abortIteration(iterationId);
    } catch (error) {
      setAbortError(messageOf(error));
    } finally {
      setAborting(false);
    }
  }

  async function handleFetchReview(iteration: Iteration) {
    if (!issueId) return;
    if (isIterationActive(iteration.status)) {
      setFetchReviewError("Нельзя получить ревью для активной итерации.");
      return;
    }
    setFetchReviewError(null);
    setFetchingReviewId(iteration.id);

    try {
      const { comments, errors } = await fetchReviewComments(iteration.id);

      if (comments.length === 0) {
        setFetchReviewError(null);
        setFetchReviewMessage("Комментариев ревью нет — код чист ✨");
        setTimeout(() => setFetchReviewMessage(null), 4000);
        return;
      }

      const lines: string[] = [
        `# Review Comments`,
        `> Fetched from MR/PR of iteration #${iteration.number}`,
        "",
      ];
      for (const c of comments) {
        const location = c.file
          ? `${c.file}${c.line !== null ? `:${c.line}` : ""}`
          : "общий комментарий";
        lines.push(
          `- **${c.author}** [${c.repo} → ${location}]:`,
          `  ${c.body}`,
          "",
        );
      }
      if (errors && errors.length > 0) {
        lines.push(
          "",
          "⚠ Некоторые MR не удалось опросить:",
          ...errors.map((e) => `  - ${e}`),
        );
      }
      const reviewText = lines.join("\n");

      const reviewFile = new File(
        [reviewText],
        `review-iteration-${iteration.number}.md`,
        { type: "text/markdown" },
      );
      form.setFiles([reviewFile]);
      form.setContext(
        `Review comments from iteration #${iteration.number}. ` +
          `See attached file for details.`,
      );
    } catch (error) {
      setFetchReviewError(
        messageOf(error),
      );
    } finally {
      setFetchingReviewId(null);
    }
  }

  async function handleQueue(iteration: Iteration) {
    if (!issueId) return;
    if (iteration.status !== TaskStatus.draft) return;
    setQueueingId(iteration.id);
    try {
      await queueIteration(iteration.id);
      replaceIterations(await getIterations(issueId));
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      setRepeatError(messageOf(error));
    } finally {
      setQueueingId(null);
    }
  }

  async function handleRepeat(iteration: Iteration) {
    if (!issueId) return;
    if (isIterationActive(iteration.status)) {
      setRepeatError(
        "Нельзя повторить активную итерацию — дождитесь её завершения или отмены.",
      );
      return;
    }
    setRepeatError(null);
    setRepeatingId(iteration.id);

    try {
      const created = await repeatIteration(iteration.id);
      replaceIterations(await getIterations(issueId));
      setSelectedIterationId(created.id);
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      setRepeatError(messageOf(error));
    } finally {
      setRepeatingId(null);
    }
  }

  async function handleStartDraft() {
    if (!issueId) return;
    setStartDraftError(null);
    setStartingDraft(true);

    try {
      const result = await startIssue(issueId);
      const iterations = await getIterations(issueId);
      setState((current) =>
        current.status === AsyncStateStatus.ready
          ? {
              ...current,
              data: {
                ...current.data,
                issue: { ...current.data.issue, status: TaskStatus.pending },
                iterations: [...iterations].sort((a, b) => a.number - b.number),
              },
            }
          : current,
      );
      setSelectedIterationId(result.iterationId);
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      setStartDraftError(
        messageOf(error),
      );
    } finally {
      setStartingDraft(false);
    }
  }

  return {
    aborting,
    abortError,
    repeatingId,
    repeatError,
    fetchingReviewId,
    queueingId,
    fetchReviewError,
    fetchReviewMessage,
    startingDraft,
    startDraftError,
    setRepeatError,
    handleAbort,
    handleFetchReview,
    handleQueue,
    handleRepeat,
    handleStartDraft,
  };
}

export type IterationActions = ReturnType<typeof useIterationActions>;