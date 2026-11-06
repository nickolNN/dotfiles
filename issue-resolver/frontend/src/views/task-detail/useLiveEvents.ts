import { useEffect, useRef, useState } from "react";
import type { SessionEvent, StepRunStatus } from "@issue-resolver/shared";
import { DELETE_TIMEOUT_MS } from "../../api/sse";
import type { WorkspaceProgressBoard } from "./types";

export function useLiveEvents() {
  const [liveEventsByRun, setLiveEventsByRun] = useState<
    Record<string, SessionEvent[]>
  >({});
  const [liveStatusByRun, setLiveStatusByRun] = useState<
    Record<string, StepRunStatus>
  >({});
  const [liveMrUrls, setLiveMrUrls] = useState<string[]>([]);
  const [iterationErrors, setIterationErrors] = useState<
    Record<string, string>
  >({});
  const [workspaceProgress, setWorkspaceProgress] =
    useState<WorkspaceProgressBoard | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteTimeoutError, setDeleteTimeoutError] = useState<string | null>(
    null,
  );
  const deleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!deleting) return;
    deleteTimeoutRef.current = setTimeout(() => {
      deleteTimeoutRef.current = null;
      setDeleting(false);
      setDeleteTimeoutError(
        "Таймаут удаления. Задача может быть удалена частично. Обновите страницу.",
      );
    }, DELETE_TIMEOUT_MS);
    return () => {
      if (deleteTimeoutRef.current) {
        clearTimeout(deleteTimeoutRef.current);
        deleteTimeoutRef.current = null;
      }
    };
  }, [deleting]);

  const scheduleProgressFade = () => {
    if (progressTimerRef.current) return;
    progressTimerRef.current = setTimeout(() => {
      progressTimerRef.current = null;
      setWorkspaceProgress((current) => {
        if (!current || current.fading) return current;
        return { ...current, fading: true };
      });
    }, 3000);
  };

  const dismissProgress = () => {
    setWorkspaceProgress((current) =>
      current ? { ...current, dismissed: true } : current,
    );
  };

  function resetLiveEvents() {
    setLiveEventsByRun({});
    setLiveStatusByRun({});
    setLiveMrUrls([]);
    setIterationErrors({});
    setWorkspaceProgress(null);
    setDeleting(false);
    setDeleteTimeoutError(null);
  }

  function clearTimers() {
    if (progressTimerRef.current) {
      clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    if (deleteTimeoutRef.current) {
      clearTimeout(deleteTimeoutRef.current);
      deleteTimeoutRef.current = null;
    }
  }

  return {
    liveEventsByRun,
    setLiveEventsByRun,
    liveStatusByRun,
    setLiveStatusByRun,
    liveMrUrls,
    setLiveMrUrls,
    iterationErrors,
    setIterationErrors,
    workspaceProgress,
    setWorkspaceProgress,
    progressTimerRef,
    scheduleProgressFade,
    dismissProgress,
    deleting,
    setDeleting,
    deleteTimeoutError,
    setDeleteTimeoutError,
    deleteTimeoutRef,
    resetLiveEvents,
    clearTimers,
  };
}

export type LiveEvents = ReturnType<typeof useLiveEvents>;
