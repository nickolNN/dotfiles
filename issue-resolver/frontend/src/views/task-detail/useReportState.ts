import { messageOf } from "../../lib/errors";
import { useMemo, useRef, useState } from "react";
import {
  IssueRunKind,
  RunState,
  SessionAddress,
  StepReportStatus,
  StepRunStatus,
  parseStepReport,
  type StepRunWithLog,
} from "@issue-resolver/shared";
import {
  getReportRun,
  getReportStatus,
  reembedReport,
  runReportAgent,
  type ReportStatus,
} from "../../api/client";
import {
  sessionEventsOf,
  type SessionEvent,
} from "../../api/session-events";
import { REPORT_POLL_FAILURES, REPORT_STALE_MS } from "./constants";
import { formatStepDuration, stepDurationMs } from "./format";
import { hydrateLaggingRun, useStatusPoll } from "./useStatusPoll";
import { useNow } from "../../lib/time";

interface UseReportStateInput {
  issueId: string | null | undefined;
  liveEventsByRun: Record<string, SessionEvent[]>;
  stepsActive: boolean;
  onArtifactsChange: () => void;
}

const REPORT_OUTCOME_STATUS: Record<RunState, StepRunStatus> = {
  [RunState.idle]: StepRunStatus.pending,
  [RunState.running]: StepRunStatus.running,
  [RunState.success]: StepRunStatus.success,
  [RunState.failed]: StepRunStatus.failed,
};

function reportPhaseOf(
  running: boolean,
  unknown: boolean,
  reported: RunState | undefined,
): RunState {
  if (running) return RunState.running;
  if (unknown) return RunState.failed;
  return reported ?? RunState.idle;
}

function successSummary(htmlAvailable: boolean): string {
  return htmlAvailable ? "Готовы HTML и markdown" : "Готов только markdown";
}

function reportCardFor(
  stored: string | null,
  phase: RunState,
  feedback: string | undefined,
  htmlAvailable: boolean,
): string | null {
  if (stored && parseStepReport(stored)) return stored;
  if (phase === RunState.success) {
    return JSON.stringify({
      status: StepReportStatus.pass,
      summary: feedback ?? successSummary(htmlAvailable),
    });
  }
  if (phase === RunState.failed) {
    return JSON.stringify({
      status: StepReportStatus.fail,
      summary: feedback ?? "прогон завершился ошибкой",
    });
  }
  return null;
}

export function useReportState({
  issueId,
  liveEventsByRun,
  stepsActive,
  onArtifactsChange,
}: UseReportStateInput) {
  const [reportExpanded, setReportExpanded] = useState(false);
  const [reportMeta, setReportMeta] = useState<{
    observedModel?: string;
    warnings: string[];
  }>({ warnings: [] });
  const [reportReady, setReportReady] = useState(false);
  const [reembedding, setReembedding] = useState(false);
  const [reportRunning, setReportRunning] = useState(false);
  const [reportStatusUnknown, setReportStatusUnknown] = useState(false);
  const [reportStarting, setReportStarting] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportStatusInfo, setReportStatusInfo] = useState<ReportStatus | null>(
    null,
  );
  const [reportRunLog, setReportRunLog] = useState<StepRunWithLog | null>(null);
  const reportStartRef = useRef(0);
  const reportRunningRef = useRef(false);
  const reportPollFailuresRef = useRef(0);
  const [reportModel, setReportModel] = useState<string>("");
  const [reportThinkingLevel, setReportThinkingLevel] = useState<string>("");

  const reportRunId = issueId
    ? SessionAddress.forIssueRun(issueId, IssueRunKind.report).toString()
    : "";
  const reportEvents = liveEventsByRun[reportRunId] ?? [];
  const reportPhase = reportPhaseOf(
    reportRunning,
    reportStatusUnknown,
    reportStatusInfo?.status,
  );
  const reportHtmlAvailable =
    reportStatusInfo?.artifacts?.html.present ?? false;
  const reportMdAvailable = reportStatusInfo?.artifacts?.md.present ?? false;
  const reportStartedAt = reportStatusInfo?.startedAt;
  const reportModalEvents = useMemo(() => {
    const seen = new Set<string>();
    const merged: SessionEvent[] = [];
    for (const event of [
      ...(reportRunLog ? sessionEventsOf(reportRunLog) : []),
      ...reportEvents,
    ]) {
      const key = JSON.stringify(event);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(event);
    }
    return merged;
  }, [reportRunLog, reportEvents]);

  const now = useNow(stepsActive || reportPhase === RunState.running);

  const reportStoredReport = reportRunLog?.report ?? null;
  const reportCardReport = reportCardFor(
    reportStoredReport,
    reportPhase,
    reportStatusInfo?.feedback,
    reportHtmlAvailable,
  );
  const reportOutcomeStatus = REPORT_OUTCOME_STATUS[reportPhase];
  const reportDuration = reportRunLog
    ? formatStepDuration(
        stepDurationMs(reportRunLog, reportPhase === RunState.running, now),
      )
    : "";

  const reportLastActivity = reportStatusInfo?.updatedAt
    ? Date.parse(reportStatusInfo.updatedAt)
    : null;
  const reportActivityStale =
    reportPhase === RunState.running &&
    reportLastActivity !== null &&
    now - reportLastActivity > REPORT_STALE_MS;
  const reportStaleMinutes =
    reportActivityStale && reportLastActivity !== null
      ? Math.max(1, Math.round((now - reportLastActivity) / 60_000))
      : 0;

  const reportPollRef = useStatusPoll<ReportStatus>({
    enabled: Boolean(issueId),
    fetch: () => getReportStatus(issueId as string),
    apply: (next, ctx) => {
      if (!next) return;
      reportPollFailuresRef.current = 0;
      setReportStatusUnknown(false);
      setReportError(null);
      setReportStatusInfo(next);
      const running = next.status === RunState.running;
      reportRunningRef.current = running;
      setReportRunning(running);
      if (next.artifacts) {
        setReportMeta({
          observedModel: next.observedModel,
          warnings: next.warnings ?? [],
        });
        setReportReady(
          next.status === RunState.success || (next.artifacts?.md.present ?? false),
        );
      }
      if (!running) {
        hydrateLaggingRun(
          () => getReportRun(issueId as string),
          ctx,
          setReportRunLog,
        );
      }
    },
    onError: () => {
      reportPollFailuresRef.current += 1;
      if (reportPollFailuresRef.current < REPORT_POLL_FAILURES) return;
      reportRunningRef.current = false;
      setReportRunning(false);
      setReportStatusUnknown(true);
      setReportError("не удалось узнать статус отчёта — сервер не отвечает");
    },
  });

  async function reembed() {
    setReembedding(true);
    setReportError(null);
    try {
      const result = await reembedReport(issueId as string);
      setReportMeta((current) => ({
        observedModel: current.observedModel,
        warnings: result.warnings,
      }));
      onArtifactsChange();
      reportPollRef.current();
    } catch (error) {
      setReportError(messageOf(error));
    } finally {
      setReembedding(false);
    }
  }

  async function refresh(issue: string) {
    if (reportStarting) return;
    setReportError(null);
    setReportStarting(true);
    reportStartRef.current = Date.now();
    try {
      const modelParam = reportModel || undefined;
      const thinkingParam = reportThinkingLevel || undefined;
      await runReportAgent(issue, modelParam, thinkingParam);
      reportPollRef.current();
    } catch (error) {
      setReportError(messageOf(error, "Не удалось запустить генерацию отчёта"));
    } finally {
      setReportStarting(false);
    }
  }

  function reset() {
    setReportReady(false);
    setReportRunning(false);
    setReportError(null);
  }

  function markRunning() {
    if (reportRunningRef.current) return false;
    reportStartRef.current = Date.now();
    reportRunningRef.current = true;
    setReportRunning(true);
    return true;
  }

  function collapse() {
    setReportExpanded(false);
  }

  return {
    now,
    reportRunId,
    reportExpanded,
    setReportExpanded,
    reportMeta,
    reportReady,
    reembedding,
    reportRunning,
    reportStarting,
    reportError,
    reportStatusInfo,
    reportRunLog,
    reportModel,
    setReportModel,
    reportThinkingLevel,
    setReportThinkingLevel,
    reportPhase,
    reportHtmlAvailable,
    reportMdAvailable,
    reportStartedAt,
    reportModalEvents,
    reportCardReport,
    reportOutcomeStatus,
    reportDuration,
    reportActivityStale,
    reportStaleMinutes,
    reembed,
    refresh,
    reset,
    markRunning,
    collapse,
  };
}