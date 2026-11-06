import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  RunState,
  StepRunStatus,
  type StepRunWithLog,
} from "@issue-resolver/shared";
import type { SessionEvent } from "../../api/session-events";
import { sessionEventsOf } from "../../api/session-events";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { STEP_LABELS } from "./constants";
import type { StepRunsState } from "./types";
import type { useReportState } from "./useReportState";
import { useChatDraft } from "./chat-drafts";
import { useAgentChat } from "./useAgentChat";
import { AsyncStateStatus } from '../../lib/async-state';

interface ModalTarget {
  title: string;
  attempt: number;
  status: StepRunStatus;
  active: boolean;
  events: SessionEvent[];
  stats: StepRunWithLog["stats"];
  stdout: string;
  stderr: string;
  report: string | null;
  startedAt: string | undefined;
  sessionId: string;
}

interface UseStepLogModalInput {
  expandedStepRunId: string | null;
  setExpandedStepRunId: Dispatch<SetStateAction<string | null>>;
  stepRuns: StepRunsState;
  liveEventsByRun: Record<string, SessionEvent[]>;
  report: ReturnType<typeof useReportState>;
  devopsExpanded: boolean;
  setDevopsExpanded: Dispatch<SetStateAction<boolean>>;
  devopsRunLog: StepRunWithLog | null;
  devopsRunId: string;
  statusOf: (run: StepRunWithLog) => StepRunStatus;
  isActiveStatus: (status: StepRunStatus) => boolean;
}

export function useStepLogModal({
  expandedStepRunId,
  setExpandedStepRunId,
  stepRuns,
  liveEventsByRun,
  report,
  devopsExpanded,
  setDevopsExpanded,
  devopsRunLog,
  devopsRunId,
  statusOf,
  isActiveStatus,
}: UseStepLogModalInput) {
  const modalScrollRef = useRef<HTMLDivElement | null>(null);
  const modalPinnedRef = useRef(true);

  const expandedStepRun =
    expandedStepRunId !== null && stepRuns.status === AsyncStateStatus.ready
      ? (stepRuns.data.find((run) => run.id === expandedStepRunId) ?? null)
      : null;
  const expandedEvents = expandedStepRun
    ? [
        ...sessionEventsOf(expandedStepRun),
        ...(liveEventsByRun[expandedStepRun.id] ?? []),
      ]
    : [];

  const devopsEvents = liveEventsByRun[devopsRunId] ?? [];

  let modalTarget: ModalTarget | null = null;
  if (expandedStepRun) {
    modalTarget = {
      title: STEP_LABELS[expandedStepRun.step],
      attempt: expandedStepRun.attempt,
      status: statusOf(expandedStepRun),
      active: isActiveStatus(statusOf(expandedStepRun)),
      events: expandedEvents,
      stats: expandedStepRun.stats ?? null,
      stdout: expandedStepRun.stdout,
      stderr: expandedStepRun.stderr,
      report: expandedStepRun.report,
      startedAt: expandedStepRun.created_at,
      sessionId: expandedStepRun.iteration_id ?? "",
    };
  } else if (report.reportExpanded) {
    modalTarget = {
      title: STEP_LABELS.report,
      attempt: 1,
      status: report.reportOutcomeStatus,
      active: report.reportPhase === RunState.running,
      events: report.reportModalEvents,
      stats: report.reportRunLog?.stats ?? null,
      stdout: report.reportRunLog?.stdout ?? "",
      stderr: report.reportRunLog?.stderr ?? "",
      report: null,
      startedAt: report.reportStartedAt,
      sessionId: report.reportRunId,
    };
  } else if (devopsExpanded && devopsRunLog) {
    modalTarget = {
      title: STEP_LABELS.devops,
      attempt: devopsRunLog.attempt,
      status: statusOf(devopsRunLog),
      active: false,
      events: sessionEventsOf(devopsRunLog),
      stats: devopsRunLog.stats ?? null,
      stdout: devopsRunLog.stdout,
      stderr: devopsRunLog.stderr,
      report: null,
      startedAt: devopsRunLog.created_at,
      sessionId: devopsRunId,
    };
  }

  const chatDraft = useChatDraft(modalTarget?.sessionId ?? "");
  const chat = useAgentChat(
    chatDraft,
    modalTarget?.sessionId ?? null,
    modalTarget?.active ?? false,
  );

  function closeModal() {
    setExpandedStepRunId(null);
    report.collapse();
    setDevopsExpanded(false);
  }

  const handleModalScroll = useCallback(() => {
    const el = modalScrollRef.current;
    if (!el) return;
    modalPinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }, []);

  useEffect(() => {
    const el = modalScrollRef.current;
    if (el && modalPinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [modalTarget?.events]);

  useEscapeKey(
    expandedStepRunId !== null || report.reportExpanded,
    closeModal,
  );

  return {
    modalTarget,
    modalScrollRef,
    handleModalScroll,
    closeModal,
    chatDraft,
    chat,
    expandedStepRun,
    expandedEvents,
    devopsEvents,
  };
}