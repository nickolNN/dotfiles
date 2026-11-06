import type { ComponentProps, Dispatch, SetStateAction } from "react";
import type { ModelDescriptor } from "@issue-resolver/shared";
import { formatDateTime } from "@issue-resolver/shared";
import { statusColor } from "../../theme";
import DeleteTimeoutNotice from "../../components/DeleteTimeoutNotice";
import DevopsPanel from "./DevopsPanel";
import InlineQuestion from "./InlineQuestion";
import IssueFilesList from "../../components/IssueFilesList";
import CalendarIcon from "../../components/icons/CalendarIcon";
import RefreshIcon from "../../components/icons/RefreshIcon";
import ReportSection from "./ReportSection";
import RepositoryStatusPanel from "./RepositoryStatusPanel";
import type { IterationActions } from "./useIterationActions";
import type { useReportState } from "./useReportState";
import type { LoadState } from "./types";
import FormError from "../../components/FormError";
import { AsyncStateStatus } from '../../lib/async-state';

type RepositoryPanelProps = ComponentProps<typeof RepositoryStatusPanel>;
type ReportSectionProps = ComponentProps<typeof ReportSection>;
type DevopsPanelProps = ComponentProps<typeof DevopsPanel>;
type IssueFilesProps = ComponentProps<typeof IssueFilesList>;
type InlineQuestionProps = ComponentProps<typeof InlineQuestion>;

interface TaskHeaderCardProps {
  state: LoadState;
  report: ReturnType<typeof useReportState>;
  iterationActions: IterationActions;
  models: ModelDescriptor[];
  deleteTimeoutError: string | null;
  setExpandedStepRunId: Dispatch<SetStateAction<string | null>>;
  repo: {
    rows: RepositoryPanelProps["rows"];
    mrItems: RepositoryPanelProps["mrItems"];
    reviewIteration: RepositoryPanelProps["reviewIteration"];
    stoppingDevServers: boolean;
    handleStopDevServers: () => Promise<void>;
    copyDevServerPort: (port: number) => Promise<void>;
    devPortCopied: boolean;
    devServerError: string | null;
  };
  devops: {
    phase: DevopsPanelProps["phase"];
    statusInfo: DevopsPanelProps["statusInfo"];
    runLog: DevopsPanelProps["runLog"];
    events: DevopsPanelProps["events"];
    starting: boolean;
    error: string | null;
    onRefresh: () => void;
    setDevopsExpanded: Dispatch<SetStateAction<boolean>>;
  };
  result: {
    available: boolean;
    ready: boolean;
    files: ReportSectionProps["resultFiles"];
    openResult: () => void;
    openJiraPreview: () => Promise<void>;
    setArtifactsOpen: Dispatch<SetStateAction<boolean>>;
  };
  files: {
    issueFiles: IssueFilesProps["files"];
    fileError: string | null;
    handleDeleteFile: (fileId: string) => Promise<void>;
    deletingFileId: string | null;
  };
  questions: {
    unanswered: InlineQuestionProps["question"][];
    submitting: InlineQuestionProps["submitting"];
    error: InlineQuestionProps["error"];
    handleResponse: (
      question: InlineQuestionProps["question"],
      payload: { value?: string; confirmed?: boolean; cancelled?: boolean },
    ) => Promise<void>;
  };
}

export default function TaskHeaderCard(props: TaskHeaderCardProps) {
  const {
    state,
    report,
    iterationActions,
    models,
    deleteTimeoutError,
    setExpandedStepRunId,
    repo,
    devops,
    result,
    files,
    questions,
  } = props;

  const {
    rows: repoRows,
    mrItems,
    reviewIteration,
    stoppingDevServers,
    handleStopDevServers,
    copyDevServerPort,
    devPortCopied,
    devServerError,
  } = repo;
  const {
    phase: devopsPhase,
    statusInfo: devopsStatusInfo,
    runLog: devopsRunLog,
    events: devopsEvents,
    starting: devopsStarting,
    error: devopsError,
    onRefresh: handleRefreshDevops,
    setDevopsExpanded,
  } = devops;
  const {
    available: resultAvailable,
    ready: resultReady,
    files: resultFiles,
    openResult,
    openJiraPreview,
    setArtifactsOpen,
  } = result;
  const { issueFiles, fileError, handleDeleteFile, deletingFileId } = files;
  const {
    unanswered: unansweredQuestions,
    submitting: questionSubmitting,
    error: questionError,
    handleResponse: handleQuestionResponse,
  } = questions;

  return (
        <div
          data-testid="task-island"
          className="rounded-none border border-[#008F11] p-4"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            {state.status === AsyncStateStatus.ready && (
              <div className="flex shrink-0 items-center gap-3 text-xs text-[#00FF41]/60">
                <span
                  data-testid="issue-created-at"
                  title="Создана"
                  aria-label="Создана"
                  className="inline-flex items-center gap-1"
                >
                  <CalendarIcon className="h-4 w-4" />
                  <time dateTime={state.data.issue.created_at}>
                    {formatDateTime(state.data.issue.created_at)}
                  </time>
                </span>
                <span
                  data-testid="issue-updated-at"
                  title="Обновлена"
                  aria-label="Обновлена"
                  className="inline-flex items-center gap-1"
                >
                  <RefreshIcon className="h-4 w-4" />
                  <time dateTime={state.data.issue.updated_at}>
                    {formatDateTime(state.data.issue.updated_at)}
                  </time>
                </span>
              </div>
            )}
          </div>

          <DeleteTimeoutNotice message={deleteTimeoutError} />

          {state.status === AsyncStateStatus.loading && (
            <p className="text-sm text-[#00FF41]/60">Загрузка…</p>
          )}
          {state.status === AsyncStateStatus.error && (
            <FormError message={`Не удалось загрузить задачу: ${state.message}`} />
          )}

          {state.status === AsyncStateStatus.ready && (
            <>
              {questionError && (
                <p
                  role="alert"
                  data-testid="question-error"
                  className="mb-4 text-sm font-medium text-[#FF0033]"
                >
                  Не удалось ответить на вопрос: {questionError}
                </p>
              )}
              <header>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="glow min-w-0 break-words text-xl font-semibold text-[#00FF41]">
                    {state.data.issue.title}
                  </h2>
                  <span
                    data-testid="issue-status"
                    data-status={state.data.issue.status}
                    className="shrink-0 text-xs uppercase tracking-wider transition-base"
                    style={{ color: statusColor[state.data.issue.status] }}
                  >
                    {state.data.issue.status}
                  </span>
                  {state.data.issue.workspace_missing === true && (
                    <span
                      data-testid="workspace-missing"
                      title="Рабочая папка задачи была удалена"
                      className="shrink-0 border border-[#FFB000] px-2 py-0.5 text-xs font-medium text-[#FFB000]"
                    >
                      Файлы задачи отсутствуют
                    </span>
                  )}
                </div>
                {repoRows.length > 0 && (
                  <RepositoryStatusPanel
                    rows={repoRows}
                    mrItems={mrItems}
                    reviewIteration={reviewIteration}
                    fetchingReviewId={iterationActions.fetchingReviewId}
                    stoppingDevServers={stoppingDevServers}
                    error={iterationActions.fetchReviewError}
                    message={iterationActions.fetchReviewMessage}
                    actions={{
                      onFetchReview: (iteration) =>
                        void iterationActions.handleFetchReview(iteration),
                      onStopDevServers: () => void handleStopDevServers(),
                      onCopyDevPort: copyDevServerPort,
                    }}
                  />
                )}
                {state.status === AsyncStateStatus.ready && (
                  <DevopsPanel
                    phase={devopsPhase}
                    statusInfo={devopsStatusInfo}
                    runLog={devopsRunLog}
                    events={devopsEvents}
                    starting={devopsStarting}
                    error={devopsError}
                    actions={{
                      onRefresh: () => void handleRefreshDevops(),
                      onOpenOutput: () => {
                        setExpandedStepRunId(null);
                        report.setReportExpanded(false);
                        setDevopsExpanded(true);
                      },
                    }}
                  />
                )}


                {state.data.issue.jira_issue_url && (
                  <div className="mt-3">
                    <button
                      type="button"
                      data-testid="open-jira-preview"
                      onClick={() => void openJiraPreview()}
                      className="min-h-9 rounded-none border border-[#00B4FF] bg-[#001018] px-3 py-1 text-xs font-medium text-[#00B4FF] hover:bg-[#00B4FF] hover:text-[#0D0208] transition-base"
                    >
                      Jira
                    </button>
                  </div>
                )}
                {devPortCopied && (
                  <p className="mt-2 text-xs text-[#00FF41]/60">Скопировано</p>
                )}
                {devServerError && (
                  <p
                    role="alert"
                    className="mt-2 text-xs font-medium text-[#FF0033]"
                  >
                    Не удалось остановить dev-серверы: {devServerError}
                  </p>
                )}

                {resultAvailable && (
                  <ReportSection
                    issue={state.data.issue}
                    models={models}
                    resultFiles={resultFiles}
                    resultReady={resultReady}
                    report={report}
                    actions={{
                      openResult: () => void openResult(),
                      setArtifactsOpen,
                      setExpandedStepRunId,
                    }}
                  />
                )}
                {fileError && (
                  <p
                    role="alert"
                    data-testid="file-error"
                    className="mt-2 text-xs text-[#FF0033]"
                  >
                    Не удалось удалить файл: {fileError}
                  </p>
                )}
                <IssueFilesList
                  files={issueFiles.filter(
                    (file) => file.iteration_id === null,
                  )}
                  onDelete={handleDeleteFile}
                  deletingId={deletingFileId}
                />
              </header>

              {unansweredQuestions.length > 0 && (
                <div className="mt-3 space-y-3">
                  {unansweredQuestions.map((question) => (
                    <InlineQuestion
                      key={question.id}
                      question={question}
                      submitting={questionSubmitting}
                      error={questionError}
                      onSubmit={(payload) =>
                        void handleQuestionResponse(question, payload)
                      }
                      onCancel={() =>
                        void handleQuestionResponse(question, {
                          cancelled: true,
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
  );
}
