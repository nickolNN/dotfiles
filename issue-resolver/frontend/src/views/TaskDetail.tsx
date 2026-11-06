import {
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  resultFilesArchiveUrl,
} from "../api/client";
import {
  useIssue,
  useIterations,
  useModels,
} from "../stores/queries";
import type { StepRunWithLog } from "@issue-resolver/shared";

import {
  isMultiAgentIteration,
} from "./task-detail/format";
import type {
  LoadState,
  StepRunsState,
  TaskDetailProps,
} from "./task-detail/types";
import { useIterationActions } from "./task-detail/useIterationActions";
import TaskDetailModals from "./task-detail/TaskDetailModals";
import TaskIsland from "./task-detail/TaskIsland";
import TaskDetailStates from "./task-detail/TaskDetailStates";
import { useDevServers } from "./task-detail/useDevServers";
import { useIssueFiles } from "./task-detail/useIssueFiles";
import { useIssueDerived } from "./task-detail/useIssueDerived";
import { useResultArtifacts } from "./task-detail/useResultArtifacts";
import { useIssueSubscription } from "./task-detail/useIssueSubscription";
import { useIssueSync } from "./task-detail/useIssueSync";
import { usePanelScroll } from "./task-detail/usePanelScroll";
import { isActiveStatus, statusOf as statusOfRun } from "./task-detail/status";
import { useStepLogModal } from "./task-detail/useStepLogModal";
import { useJiraPreview } from "./task-detail/useJiraPreview";
import { useLiveEvents } from "./task-detail/useLiveEvents";
import { useDevopsState } from "./task-detail/useDevopsState";
import { useIterationForm } from "./task-detail/useIterationForm";
import QueryBoundary from "../components/QueryBoundary";
import { useQuestionAnswer } from "./task-detail/useQuestionAnswer";
import { useQuestionFeed } from "./task-detail/useQuestionFeed";
import { useStepRunsState } from "./task-detail/useStepRunsState";
import { useReportState } from "./task-detail/useReportState";
import { AsyncStateStatus } from '../lib/async-state';

export { formatStepDuration, stepChangedFiles } from "./task-detail/format";
export { shortPath } from "../lib/format";

export default function TaskDetail(props: TaskDetailProps) {
  return (
    <QueryBoundary>
      <TaskDetailView {...props} />
    </QueryBoundary>
  );
}

function TaskDetailView({ issueId, autoOpenResult }: TaskDetailProps) {
  const queryClient = useQueryClient();
  const issueQuery = useIssue(issueId);
  const iterationsQuery = useIterations(issueId);
  const [state, setState] = useState<LoadState>({ status: AsyncStateStatus.loading });

  const { models, modelsLoading } = useModels();

  const [refreshTick, setRefreshTick] = useState(0);

  const form = useIterationForm({
    issueId,
    state,
    models,
    setState,
    onCreated: () => setRefreshTick((tick) => tick + 1),
  });

  const [expandedStepRunId, setExpandedStepRunId] = useState<string | null>(
    null,
  );
  const [selectedIterationId, setSelectedIterationId] = useState<string | null>(
    null,
  );
  const iterationActions = useIterationActions({
    issueId,
    form,
    setState,
    setRefreshTick,
    setSelectedIterationId,
  });

  const {
    issueFiles,
    deletingFileId,
    fileError,
    handleDeleteFile,
  } = useIssueFiles(issueId, refreshTick);

  const {
    stoppingDevServers,
    devServerError,
    devPortCopied,
    handleStopDevServers,
    copyDevServerPort,
  } = useDevServers({
    issueId: state.status === AsyncStateStatus.ready ? state.data.issue.id : null,
    setState,
  });

  const {
    jiraPreviewOpen,
    jiraPreviewText,
    jiraPreviewLoading,
    openJiraPreview,
    closeJiraPreview,
  } = useJiraPreview({
    issueId: state.status === AsyncStateStatus.ready ? state.data.issue.id : null,
    jiraUrl: state.status === AsyncStateStatus.ready ? state.data.issue.jira_issue_url : null,
  });



  const {
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
  } = useDevopsState(issueId);


  const panelRef = useRef<HTMLDivElement | null>(null);
  const iterationsRef = useRef<HTMLDivElement | null>(null);

  usePanelScroll({
    issueId,
    panelRef,
    iterationsRef,
    scrollToIterations: form.scrollToIterations,
    onScrolled: () => form.setScrollToIterations(false),
  });

  const live = useLiveEvents();
  const {
    liveEventsByRun,
    liveStatusByRun,
    liveMrUrls,
    iterationErrors,
    workspaceProgress,
    deleting,
    deleteTimeoutError,
    dismissProgress,
  } = live;

  const statusOf = (run: Pick<StepRunWithLog, "id" | "status">) =>
    statusOfRun(run, liveStatusByRun);

  const activeIterationId =
    selectedIterationId ??
    (state.status === AsyncStateStatus.ready && state.data.iterations.length > 0
      ? state.data.iterations[state.data.iterations.length - 1].id
      : null);

  const {
    questionSubmitting,
    questionError,
    answeredQuestionIds,
    resetQuestions,
    handleQuestionResponse,
  } = useQuestionAnswer(activeIterationId, refreshTick);

  useIssueSync({
    issueId,
    issueQuery,
    iterationsQuery,
    setState,
    onIssueChange: () => resetQuestions(),
    onIssueLoaded: (issue) => {
      form.setSelectedSteps(issue.pipeline_steps);
      if (form.prRepoIdsSeeded) return;
      form.setPrRepoIds(
        new Set(
          issue.repositories
            .filter((repo) => repo.create_mr)
            .map((repo) => repo.id),
        ),
      );
      form.setPrRepoIdsSeeded(true);
    },
  });

  const stepRuns: StepRunsState = useStepRunsState({
    activeIterationId,
    refreshTick,
    resetLiveStatus: () => live.setLiveStatusByRun({}),
  });

  const anyActiveStep =
    stepRuns.status === AsyncStateStatus.ready &&
    stepRuns.data.some((run) => isActiveStatus(statusOf(run)));
  const report = useReportState({
    issueId,
    liveEventsByRun,
    stepsActive: anyActiveStep,
    onArtifactsChange: () => setRefreshTick((tick) => tick + 1),
  });
  const now = report.now;


  useIssueSubscription({
    issueId,
    live,
    report,
    resetDevops,
    setState,
    setRefreshTick,
    queryClient,
  });

  const {
    modalTarget,
    modalScrollRef,
    handleModalScroll,
    closeModal,
    chatDraft,
    chat,
    expandedEvents,
    devopsEvents,
  } = useStepLogModal({
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
  });

  const { unansweredQuestions } = useQuestionFeed({
    stepRuns,
    liveEventsByRun,
    liveStatusByRun,
    answeredQuestionIds,
    expandedEvents,
    chatDraft,
    statusOf,
    isActiveStatus,
  });

  const {
    orderedIterations,
    resultAvailable,
    mrItems,
    resultReady,
    repoRows,
    reviewIteration,
  } = useIssueDerived({ state, liveMrUrls, workspaceProgress });

  const {
    resultOpen,
    setResultOpen,
    artifactMeta,
    resultMd,
    resultFiles,
    artifactsOpen,
    setArtifactsOpen,
    openResult,
  } = useResultArtifacts({
    issueId,
    refreshTick,
    resultReady,
    autoOpenResult,
    stateReady: state.status === AsyncStateStatus.ready,
  });

  const agentsIteration =
    stepRuns.status === AsyncStateStatus.ready && isMultiAgentIteration(stepRuns.data);
  if (!issueId || deleting) {
    return <TaskDetailStates issueId={issueId} deleting={deleting} />;
  }

  return (
    <>
      <TaskIsland
        state={state}
        report={report}
        iterationActions={iterationActions}
        form={form}
        models={models}
        modelsLoading={modelsLoading}
        deleteTimeoutError={deleteTimeoutError}
        repo={{
          rows: repoRows,
          mrItems,
          reviewIteration,
          stoppingDevServers,
          handleStopDevServers,
          copyDevServerPort,
          devPortCopied,
          devServerError,
        }}
        devops={{
          phase: devopsPhase,
          statusInfo: devopsStatusInfo,
          runLog: devopsRunLog,
          events: devopsEvents,
          starting: devopsStarting,
          error: devopsError,
          onRefresh: () => void handleRefreshDevops(),
          setDevopsExpanded,
        }}
        result={{
          available: resultAvailable,
          ready: resultReady,
          files: resultFiles,
          openResult: () => void openResult(),
          openJiraPreview,
          setArtifactsOpen,
        }}
        files={{ issueFiles, fileError, handleDeleteFile, deletingFileId }}
        questions={{
          unanswered: unansweredQuestions,
          submitting: questionSubmitting,
          error: questionError,
          handleResponse: handleQuestionResponse,
        }}
        progress={{ workspaceProgress, dismissProgress }}
        iterations={{
          ordered: orderedIterations,
          activeIterationId,
          setSelectedIterationId,
          stepRuns,
          liveStatusByRun,
          liveEventsByRun,
          refreshTick,
          now,
          iterationErrors,
          agentsIteration,
          setExpandedStepRunId,
        }}
        refs={{ panelRef, iterationsRef }}
      />

      <TaskDetailModals
        state={state}
        result={{
          open: resultOpen,
          available: resultAvailable,
          ready: resultReady,
          artifactMeta,
          markdown: resultMd,
          onClose: () => setResultOpen(false),
        }}
        jira={{
          open: jiraPreviewOpen,
          loading: jiraPreviewLoading,
          text: jiraPreviewText,
          onClose: closeJiraPreview,
        }}
        artifacts={{
          open: artifactsOpen,
          files: resultFiles,
          archiveUrl:
            state.status === AsyncStateStatus.ready ? resultFilesArchiveUrl(state.data.issue.id) : "",
          onClose: () => setArtifactsOpen(false),
        }}
        agent={{
          target: modalTarget,
          iterationId: activeIterationId,
          aborting: iterationActions.aborting,
          abortError: iterationActions.abortError,
          onAbort: (iterationId) => void iterationActions.handleAbort(iterationId),
          onClose: closeModal,
          chat,
          draft: chatDraft,
          scrollRef: modalScrollRef,
          onScroll: handleModalScroll,
        }}
      />
    </>
  );
}
