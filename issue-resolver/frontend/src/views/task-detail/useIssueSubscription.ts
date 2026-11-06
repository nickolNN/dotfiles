import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { IssueDeletingPhase, TaskStatus, WorkspaceProgressStatus, type SessionEvent } from "@issue-resolver/shared";
import { subscribeToIssueEvents } from "../../api/sse";
import { isWorkspaceProgressStatus } from "./constants";
import { isStepRunStatus } from "./format";
import type { LiveEvents } from "./useLiveEvents";
import { AsyncStateStatus } from '../../lib/async-state';
import type {
  LoadState,
  WorkspaceProgressBoard,
  WorkspaceProgressRow,
} from "./types";

interface UseIssueSubscriptionInput {
  issueId: string | null | undefined;
  live: LiveEvents;
  report: { reset: () => void; markRunning: () => boolean };
  resetDevops: () => void;
  setState: Dispatch<SetStateAction<LoadState>>;
  setRefreshTick: Dispatch<SetStateAction<number>>;
  queryClient: QueryClient;
}

export function useIssueSubscription({
  issueId,
  live,
  report,
  resetDevops,
  setState,
  setRefreshTick,
  queryClient,
}: UseIssueSubscriptionInput) {
  const {
    setLiveEventsByRun,
    setLiveStatusByRun,
    setLiveMrUrls,
    setIterationErrors,
    setWorkspaceProgress,
    progressTimerRef,
    scheduleProgressFade,
    setDeleting,
    setDeleteTimeoutError,
    deleteTimeoutRef,
    resetLiveEvents,
    clearTimers,
  } = live;

  useEffect(() => {
    if (!issueId) return;

    resetLiveEvents();
    report.reset();
    resetDevops();

    const unsubscribe = subscribeToIssueEvents(issueId, {
      onLog: (event) => {
        if (event.stream === "mr") {
          const url = event.data.trim();
          if (!url) return;
          setLiveMrUrls((current) =>
            current.includes(url) ? current : [...current, url],
          );
          return;
        }
        if (event.stream !== "stdout" && event.stream !== "stderr") return;
        const stepRunId = event.stepRunId;
        if (!stepRunId || event.data === "") return;
        setLiveEventsByRun((current) => {
          const events = current[stepRunId] ?? [];
          const last = events[events.length - 1];
          const next: SessionEvent[] =
            last?.type === "text"
              ? [
                  ...events.slice(0, -1),
                  { type: "text", text: last.text + event.data },
                ]
              : [...events, { type: "text", text: event.data }];
          return { ...current, [stepRunId]: next.slice(-500) };
        });
      },
      onStepEvent: (payload, raw) => {
        const stepRunId = payload.stepRunId ?? raw.stepRunId;
        if (!stepRunId) return;
        setLiveEventsByRun((current) => ({
          ...current,
          [stepRunId]: [...(current[stepRunId] ?? []), payload.event].slice(
            -500,
          ),
        }));
      },
      onStepStatus: (event) => {
        const stepRunId = event.stepRunId;
        let status: string = event.data;
        try {
          const parsed = JSON.parse(event.data) as { status?: unknown };
          if (typeof parsed?.status === "string") status = parsed.status;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        if (stepRunId && isStepRunStatus(status)) {
          setLiveStatusByRun((current) => ({
            ...current,
            [stepRunId]: status,
          }));
          setRefreshTick((tick) => tick + 1);
        }
      },
      onIterationStatus: (event) => {
        let parsedData: { status?: string; error?: string } = {};
        try {
          parsedData = JSON.parse(event.data) as {
            status?: string;
            error?: string;
          };
        } catch {
          parsedData = {};
        }
        const status = parsedData.status;
        const error =
          typeof parsedData.error === "string" ? parsedData.error : undefined;
        const failedIterationId = event.iterationId;
        if (status === TaskStatus.failed && error && failedIterationId) {
          setIterationErrors((current) => ({
            ...current,
            [failedIterationId]: error,
          }));
        }
        if (status === TaskStatus.question || status === TaskStatus.running) {
          setState((current) =>
            current.status === AsyncStateStatus.ready
              ? {
                  ...current,
                  data: {
                    ...current.data,
                    issue: { ...current.data.issue, status },
                  },
                }
              : current,
          );
          if (status === TaskStatus.question) {
            setRefreshTick((tick) => tick + 1);
          }
        }
        if (
          status === TaskStatus.completed ||
          status === TaskStatus.failed ||
          status === TaskStatus.cancelled
        ) {
          if (!report.markRunning()) return;
          void queryClient.invalidateQueries({ queryKey: ["issue", issueId] });
          void queryClient.invalidateQueries({
            queryKey: ["iterations", issueId],
          });
          setRefreshTick((tick) => tick + 1);
        }
      },
      onWorkspaceProgress: (payload) => {
        if (!isWorkspaceProgressStatus(payload.status)) return;
        const status = payload.status;
        const fresh = payload.step === "creating_dirs" && status === WorkspaceProgressStatus.running;
        if (fresh && progressTimerRef.current) {
          clearTimeout(progressTimerRef.current);
          progressTimerRef.current = null;
        }
        const key = `${payload.step}:${payload.repo ?? ""}`;
        setWorkspaceProgress((current) => {
          const entry: WorkspaceProgressBoard =
            fresh || !current
              ? { steps: [], finished: false, fading: false, dismissed: false }
              : current;
          const existing = entry.steps.findIndex((step) => step.key === key);
          const next: WorkspaceProgressRow = {
            key,
            step: payload.step,
            repo: payload.repo,
            status,
            message: payload.message,
            devPort: payload.devPort,
          };
          const steps =
            existing >= 0
              ? entry.steps.map((step, index) =>
                  index === existing ? { ...step, ...next } : step,
                )
              : [...entry.steps, next];
          const finished =
            entry.finished || payload.step === "ready" || status === WorkspaceProgressStatus.error;
          return { ...entry, steps, finished };
        });
        if (payload.step === "ready" || status === WorkspaceProgressStatus.error) {
          scheduleProgressFade();
        }
      },
      onIssueDeleting: (payload) => {
        if (payload.issueId !== issueId) return;
        if (payload.phase === IssueDeletingPhase.error) {
          if (deleteTimeoutRef.current) {
            clearTimeout(deleteTimeoutRef.current);
            deleteTimeoutRef.current = null;
          }
          setDeleting(false);
          setDeleteTimeoutError(payload.message ?? "Не удалось удалить задачу");
          return;
        }
        setDeleting(true);
      },
      onIssueDeleted: (payload) => {
        if (payload.issueId !== issueId) return;
        if (deleteTimeoutRef.current) {
          clearTimeout(deleteTimeoutRef.current);
          deleteTimeoutRef.current = null;
        }
        setDeleting(true);
        window.history.pushState(null, "", "/tasks");
        window.dispatchEvent(new PopStateEvent("popstate"));
      },
    });

    return () => {
      unsubscribe();
      clearTimers();
    };
  }, [issueId]);

}
