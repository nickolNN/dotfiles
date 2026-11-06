import { RunState } from "@issue-resolver/shared";
import type {
  Issue,
  ModelDescriptor,
  WorkspaceFile,
} from "@issue-resolver/shared";
import { API_BASE } from "../../api/client";
import ModelThinkingSelect from "../../components/ModelThinkingSelect";
import RunOutcome from "../../components/RunOutcome";
import RunStatsLine from "../../components/RunStatsLine";
import { resolveFooter } from "../../components/SessionStatsBar";
import { thinkingLevelsFor } from "../../constants/thinking-levels";
import { RESULT_MD_FILENAME } from "./constants";
import { formatStepDuration } from "./format";
import type { useReportState } from "./useReportState";

interface ReportSectionActions {
  openResult: () => void;
  setArtifactsOpen: (open: boolean) => void;
  setExpandedStepRunId: (id: string | null) => void;
}

export interface ReportSectionProps {
  issue: Issue;
  models: ModelDescriptor[];
  resultFiles: WorkspaceFile[];
  resultReady: boolean;
  report: ReturnType<typeof useReportState>;
  actions: ReportSectionActions;
}

function ReportStatusChip({
  reportPhase,
  reportStartedAt,
  now,
  reportMdAvailable,
  reportHtmlAvailable,
}: {
  reportPhase: RunState;
  reportStartedAt: string | undefined;
  now: number;
  reportMdAvailable: boolean;
  reportHtmlAvailable: boolean;
}) {
  if (reportPhase === RunState.running) {
    return (
      <span data-testid="report-generating" className="text-[#FFB000]">
        ⏳ Генерируется
        {reportStartedAt
          ? ` · ${formatStepDuration(now - Date.parse(reportStartedAt))}`
          : "…"}
      </span>
    );
  }
  if (reportPhase === RunState.failed && reportMdAvailable) {
    return (
      <span
        data-testid="report-failed-with-artifacts"
        className="text-[#FFB000]"
      >
        ⚠ Отчёт есть, прогон прерван
      </span>
    );
  }
  if (reportPhase === RunState.failed) {
    return (
      <span data-testid="report-failed" className="text-[#FF0033]">
        ✕ Прогон упал
      </span>
    );
  }
  if (reportPhase === RunState.success && reportHtmlAvailable) {
    return (
      <span data-testid="report-ready" className="text-[#00FF41]/80">
        ✓ Готов: HTML + MD
      </span>
    );
  }
  if (reportPhase === RunState.success) {
    return (
      <span data-testid="report-md-only" className="text-[#FFB000]">
        ⚠ Только markdown
      </span>
    );
  }
  return (
    <span data-testid="report-idle" className="text-[#00FF41]/50">
      Отчёт ещё не сгенерирован
    </span>
  );
}

export default function ReportSection({
  issue,
  models,
  resultFiles,
  resultReady,
  report,
  actions,
}: ReportSectionProps) {
  const {
    now,
    reportStatusInfo,
    reportMeta,
    reportPhase,
    reportStartedAt,
    reportMdAvailable,
    reportHtmlAvailable,
    reportRunning,
    reportReady,
    reportActivityStale,
    reportStaleMinutes,
    reportStarting,
    reportCardReport,
    reportDuration,
    reportError,
    reportRunLog,
    reportModalEvents,
    reportOutcomeStatus,
    reportModel,
    reportThinkingLevel,
    reembedding,
    reembed,
    refresh,
    setReportModel,
    setReportThinkingLevel,
    setReportExpanded,
  } = report;
  return (
      <section
        data-testid="report-section"
        className="mt-3 border border-[#008F11] bg-[#002B00]/40 px-3 py-2 text-xs"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-xs uppercase tracking-wider text-[#00FF41]/60">
            📄 Отчёт и артефакты
          </h4>
          <span className="ml-auto text-xs">
            <ReportStatusChip
              reportPhase={reportPhase}
              reportStartedAt={reportStartedAt}
              now={now}
              reportMdAvailable={reportMdAvailable}
              reportHtmlAvailable={reportHtmlAvailable}
            />
            {reportActivityStale && (
              <span
                data-testid="report-stale"
                className="ml-2 text-[#FF0033]"
              >
                ⚠ нет активности {reportStaleMinutes} мин
              </span>
            )}
          </span>
          {reportModalEvents.length > 0 && (
            <button
              type="button"
              data-testid="report-expand"
              onClick={() => {
                actions.setExpandedStepRunId(null);
                setReportExpanded(true);
              }}
              className="shrink-0 border border-[#008F11] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] transition-base"
            >
              Развернуть
            </button>
          )}
        </div>

        {reportStatusInfo?.feedback && (
          <p
            data-testid="report-feedback"
            className="mt-2 border-l-2 border-[#008F11] pl-2 text-xs text-[#00FF41]/60"
          >
            {reportStatusInfo.feedback}
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="open-result"
            disabled={!resultReady}
            onClick={() => void actions.openResult()}
            className="min-h-9 rounded-none border border-[#00FF41] bg-[#003B00] px-3 py-1 text-xs font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[#003B00] disabled:hover:text-[#00FF41] transition-base"
          >
            Показать отчёт
          </button>
          <button
            type="button"
            data-testid="open-artifacts"
            onClick={() => actions.setArtifactsOpen(true)}
            disabled={!resultReady || resultFiles.length === 0}
            className="min-h-9 rounded-none border border-[#008F11] px-3 py-1 text-xs font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[#008F11] disabled:hover:text-[#00FF41]/80 transition-base"
          >
            Артефакты ({resultFiles.length})
          </button>
          {reportReady && (
            <a
              data-testid="report-md"
              href={`${API_BASE}/issues/${issue.id}/result/md/download`}
              download={RESULT_MD_FILENAME}
              className="inline-flex min-h-9 items-center rounded-none border border-[#008F11] px-3 py-1 text-xs font-medium text-[#00FF41]/80 transition-base hover:border-[#00FF41] hover:text-[#00FF41]"
            >
              📥 MD
            </a>
          )}
          {reportMdAvailable && (
            <button
              type="button"
              data-testid="reembed-report"
              disabled={reembedding || reportPhase === RunState.running}
              onClick={() => void reembed()}
              className="min-h-9 rounded-none border border-[#008F11] px-3 py-1 text-xs font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] disabled:cursor-not-allowed disabled:opacity-40 transition-base"
            >
              {reembedding ? "Пересобираю…" : "Пересобрать HTML"}
            </button>
          )}
          <button
            type="button"
            data-testid="refresh-report"
            disabled={reportStarting}
            onClick={() => void refresh(issue.id)}
            className="min-h-9 rounded-none border border-[#008F11] px-3 py-1 text-xs font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[#008F11] disabled:hover:text-[#00FF41]/80 transition-base"
          >
            🔄 Обновить
          </button>
        </div>

        {models.length > 0 && (
          <details className="mt-2">
            <summary className="w-fit cursor-pointer text-[11px] text-[#00FF41]/50 hover:text-[#00FF41]/80">
              ⚙ Выбрать модель
            </summary>
            <div className="mt-1">
              <ModelThinkingSelect
                models={models}
                thinkingLevels={thinkingLevelsFor(
                  models.find(
                    (m) => `${m.provider}/${m.id}` === reportModel,
                  ),
                )}
                modelValue={reportModel}
                thinkingValue={reportThinkingLevel}
                disabled={reportRunning}
                thinkingDisabled={!reportModel}
                modelOptionValue={(m) => `${m.provider}/${m.id}`}
                modelOptionLabel={(m) => m.id}
                modelPlaceholder="модель по умолчанию"
                thinkingPlaceholder="thinking по умолчанию"
                modelTestId="report-model-select"
                thinkingTestId="report-thinking-select"
                modelSelectClassName="min-h-9 rounded-none border border-[#008F11] bg-[#0D0208] px-2 py-1 text-xs text-[#00FF41]/80"
                thinkingSelectClassName="min-h-9 rounded-none border border-[#008F11] bg-[#0D0208] px-2 py-1 text-xs text-[#00FF41]/80"
                onModelChange={setReportModel}
                onThinkingChange={setReportThinkingLevel}
              />
            </div>
          </details>
        )}

        {(reportMeta.warnings.length > 0 ||
          Boolean(reportMeta.observedModel)) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {reportMeta.warnings.length > 0 && (
              <span
                role="status"
                data-testid="report-warnings"
                className="text-xs text-[#FFB000]/80"
              >
                ⚠ {reportMeta.warnings.join(" · ")}
              </span>
            )}
            {reportMeta.observedModel && (
              <span
                data-testid="report-observed-model"
                className="text-[11px] text-[#00FF41]/50"
              >
                Модель прогона: {reportMeta.observedModel}
              </span>
            )}
          </div>
        )}
        {reportError && (
          <p
            role="alert"
            data-testid="report-error"
            className="mt-2 text-xs font-medium text-[#FF0033]"
          >
            {reportError}
          </p>
        )}

        {(reportRunLog || reportPhase === RunState.running) && (
          <RunOutcome
            prefix="report"
            status={reportOutcomeStatus}
            events={reportModalEvents}
            stats={reportRunLog?.stats ?? null}
            report={reportCardReport}
            startedAt={reportStartedAt ?? reportRunLog?.created_at}
            live={reportPhase === RunState.running}
          />
        )}
        <RunStatsLine
          prefix="report"
          duration={reportDuration}
          cost={reportRunLog?.stats?.cost ?? null}
          costEstimate={reportRunLog?.stats?.costFromProvider !== true}
          footer={resolveFooter(
            reportModalEvents,
            reportRunLog?.stats ?? null,
          )}
        />
      </section>
  );
}
