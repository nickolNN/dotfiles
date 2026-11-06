import { useState } from "react";
import {
  IssueRunKind,
  RunState,
  SessionAddress,
  type StepRunWithLog,
} from "@issue-resolver/shared";
import {
  getDevopsRun,
  getDevopsStatus,
  runDevopsAgent,
  type DevopsStatus,
} from "../../api/client";
import { messageOf } from "../../lib/errors";
import { hydrateLaggingRun, useStatusPoll } from "./useStatusPoll";

export function useDevopsState(issueId: string | null | undefined) {
  const [devopsRunning, setDevopsRunning] = useState(false);
  const [devopsStarting, setDevopsStarting] = useState(false);
  const [devopsError, setDevopsError] = useState<string | null>(null);
  const [devopsStatusInfo, setDevopsStatusInfo] = useState<DevopsStatus | null>(
    null,
  );
  const [devopsRunLog, setDevopsRunLog] = useState<StepRunWithLog | null>(null);
  const [devopsExpanded, setDevopsExpanded] = useState(false);
  const devopsPollRef = useStatusPoll<DevopsStatus>({
    enabled: Boolean(issueId),
    fetch: () => getDevopsStatus(issueId as string),
    apply: (next, ctx) => {
      setDevopsError(null);
      setDevopsStatusInfo(next);
      setDevopsRunning(next.status === RunState.running);
      if (next.status !== RunState.running) {
        hydrateLaggingRun(
          () => getDevopsRun(issueId as string),
          ctx,
          setDevopsRunLog,
        );
      }
    },
    onError: () => setDevopsError("не удалось узнать статус DevOps"),
  });

  function resetDevops() {
    setDevopsRunning(false);
    setDevopsStarting(false);
    setDevopsError(null);
    setDevopsStatusInfo(null);
    setDevopsRunLog(null);
    setDevopsExpanded(false);
  }

  async function handleRefreshDevops() {
    if (!issueId || devopsStarting || devopsRunning) return;
    setDevopsError(null);
    setDevopsStarting(true);
    try {
      await runDevopsAgent(issueId);
      devopsPollRef.current();
    } catch (error) {
      setDevopsError(messageOf(error, "Не удалось запустить DevOps"));
    } finally {
      setDevopsStarting(false);
    }
  }

  const devopsPhase: DevopsStatus["status"] = devopsStatusInfo?.status ?? RunState.idle;
  const devopsRunId = issueId
    ? SessionAddress.forIssueRun(issueId, IssueRunKind.devops).toString()
    : "";

  return {
    devopsRunning,
    devopsStarting,
    devopsError,
    devopsStatusInfo,
    devopsRunLog,
    devopsExpanded,
    setDevopsExpanded,
    devopsPhase,
    devopsRunId,
    resetDevops,
    handleRefreshDevops,
  };
}