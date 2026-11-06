import type { ComponentProps, Dispatch, RefObject, SetStateAction } from "react";
import type { ModelDescriptor } from "@issue-resolver/shared";
import IterationLauncher from "./IterationLauncher";
import IterationList from "./IterationList";
import TaskHeaderCard from "./TaskHeaderCard";
import WorkspaceProgressPanel from "./WorkspaceProgressPanel";
import type { IterationActions } from "./useIterationActions";
import type { IterationForm } from "./useIterationForm";
import type { useReportState } from "./useReportState";
import type { LoadState } from "./types";
import { AsyncStateStatus } from '../../lib/async-state';

type IterationListProps = ComponentProps<typeof IterationList>;
type WorkspaceProgressProps = ComponentProps<typeof WorkspaceProgressPanel>;
type HeaderProps = ComponentProps<typeof TaskHeaderCard>;

interface TaskIslandProps {
  state: LoadState;
  report: ReturnType<typeof useReportState>;
  iterationActions: IterationActions;
  form: IterationForm;
  models: ModelDescriptor[];
  modelsLoading: boolean;
  deleteTimeoutError: string | null;
  repo: HeaderProps["repo"];
  devops: HeaderProps["devops"];
  result: HeaderProps["result"];
  files: HeaderProps["files"];
  questions: HeaderProps["questions"];
  progress: {
    workspaceProgress: WorkspaceProgressProps["progress"] | null;
    dismissProgress: () => void;
  };
  iterations: {
    ordered: IterationListProps["iterations"];
    activeIterationId: string | null;
    setSelectedIterationId: Dispatch<SetStateAction<string | null>>;
    stepRuns: IterationListProps["stepRuns"];
    liveStatusByRun: IterationListProps["live"]["statusByRun"];
    liveEventsByRun: IterationListProps["live"]["eventsByRun"];
    refreshTick: IterationListProps["live"]["refreshTick"];
    now: IterationListProps["live"]["now"];
    iterationErrors: IterationListProps["iterationErrors"];
    agentsIteration: IterationListProps["agentsIteration"];
    setExpandedStepRunId: Dispatch<SetStateAction<string | null>>;
  };
  refs: {
    panelRef: RefObject<HTMLDivElement | null>;
    iterationsRef: RefObject<HTMLDivElement | null>;
  };
}

export default function TaskIsland(props: TaskIslandProps) {
  const {
    state,
    report,
    iterationActions,
    form,
    models,
    modelsLoading,
    deleteTimeoutError,
    repo,
    devops,
    result,
    files,
    questions,
    progress,
    iterations,
    refs,
  } = props;

  const { issueFiles, handleDeleteFile, deletingFileId } = files;
  const { workspaceProgress, dismissProgress } = progress;
  const {
    ordered: orderedIterations,
    activeIterationId,
    setSelectedIterationId,
    stepRuns,
    liveStatusByRun,
    liveEventsByRun,
    refreshTick,
    now: liveNow,
    iterationErrors,
    agentsIteration,
    setExpandedStepRunId,
  } = iterations;
  const { panelRef, iterationsRef } = refs;

  return (
    <div ref={panelRef} className="mx-auto max-w-4xl py-6 px-3 sm:px-4 md:px-6">
      <div className="space-y-4">
        <TaskHeaderCard
          state={state}
          report={report}
          iterationActions={iterationActions}
          models={models}
          deleteTimeoutError={deleteTimeoutError}
          setExpandedStepRunId={setExpandedStepRunId}
          repo={repo}
          devops={devops}
          result={result}
          files={files}
          questions={questions}
        />

        <IterationLauncher
          state={state}
          form={form}
          actions={iterationActions}
          models={models}
          modelsLoading={modelsLoading}
        />

        {state.status === AsyncStateStatus.ready &&
          workspaceProgress &&
          !workspaceProgress.dismissed && (
            <WorkspaceProgressPanel
              progress={workspaceProgress}
              onFinished={dismissProgress}
            />
          )}

        {state.status === AsyncStateStatus.ready && (
          <IterationList
            iterations={orderedIterations}
            activeIterationId={activeIterationId}
            onSelect={setSelectedIterationId}
            actions={{
              aborting: iterationActions.aborting,
              onAbort: (iterationId) => void iterationActions.handleAbort(iterationId),
              abortError: iterationActions.abortError,
              repeatingId: iterationActions.repeatingId,
              onRepeat: (iteration) => void iterationActions.handleRepeat(iteration),
              queueingId: iterationActions.queueingId,
              onQueue: (iteration) => void iterationActions.handleQueue(iteration),
            }}
            files={{
              files: issueFiles,
              onDelete: (fileId) => void handleDeleteFile(fileId),
              deletingId: deletingFileId,
            }}
            stepRuns={stepRuns}
            live={{
              statusByRun: liveStatusByRun,
              eventsByRun: liveEventsByRun,
              now: liveNow,
              refreshTick,
            }}
            iterationErrors={iterationErrors}
            agentsIteration={agentsIteration}
            repeatError={iterationActions.repeatError}
            listRef={iterationsRef}
            onExpandStep={setExpandedStepRunId}
          />
        )}
      </div>    </div>
  );
}
