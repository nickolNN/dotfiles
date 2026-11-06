import {
  PipelineStep,
  StepRunStatus,
  parseStepReport,
  type StepRunWithLog,
} from "@issue-resolver/shared";
import type { SessionEvent } from "../../api/session-events";
import ErrorAlert from "../../components/ErrorAlert";
import RunOutcome from "../../components/RunOutcome";
import RunStatsLine from "../../components/RunStatsLine";
import { resolveFooter } from "../../components/SessionStatsBar";
import StepAgentTabs from "../../components/StepAgentTabs";
import { stepStatusColor } from "../../theme";
import { shortPath } from "../../lib/format";
import { STEP_LABELS } from "./constants";
import {
  formatStepDuration,
  stepChangedFiles,
  stepDurationMs,
} from "./format";

interface StepRunLogProps {
  run: StepRunWithLog;
  events: SessionEvent[];
  status: StepRunStatus;
  now: number;
  agentsIteration: boolean;
  refreshTick: number;
  onExpand: (runId: string) => void;
}

export default function StepRunLog({
  run,
  events,
  status,
  now,
  agentsIteration,
  refreshTick,
  onExpand,
}: StepRunLogProps) {
  const report = parseStepReport(run.report ?? "");
  const stepLive = status === StepRunStatus.running;
  const duration = formatStepDuration(stepDurationMs(run, stepLive, now));
  const changedFiles = stepChangedFiles(events);
  const isAgentResolve = agentsIteration && run.step === PipelineStep.resolve;
  const footer = resolveFooter(isAgentResolve ? [] : events, run.stats ?? null);

  return (
    <li
      data-testid="step-run-log"
      data-step-run-id={run.id}
      className="rounded-none border border-[#008F11] p-3 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[#00FF41]">{STEP_LABELS[run.step]}</span>
        {run.attempt > 1 && (
          <span className="text-[#00FF41]/60">попытка {run.attempt}</span>
        )}
        <span style={{ color: stepStatusColor[status] }}>{status}</span>
        <button
          type="button"
          data-testid="step-expand"
          onClick={(event) => {
            event.stopPropagation();
            onExpand(run.id);
          }}
          className="ml-auto shrink-0 border border-[#008F11] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] transition-base"
        >
          Развернуть
        </button>
      </div>

      {report?.pr_error && (
        <ErrorAlert testId="step-pr-error" className="mt-2 font-medium">
          ⚠ MR/ветка не созданы: {report.pr_error}
        </ErrorAlert>
      )}

      <RunOutcome
        prefix="step"
        status={status}
        events={events}
        stats={run.stats ?? null}
        report={run.report ?? null}
        startedAt={run.created_at}
        liveView={
          isAgentResolve ? (
            <StepAgentTabs
              iterationId={run.iteration_id ?? ""}
              refreshKey={refreshTick}
            />
          ) : undefined
        }
      />

      <RunStatsLine
        prefix="step"
        duration={duration}
        cost={run.stats?.cost}
        costEstimate={run.stats?.costFromProvider !== true}
        footer={footer}
      >
        <span data-testid="step-files">
          {changedFiles.length === 0
            ? "Файлы не изменялись"
            : `Файлы: ${changedFiles
                .slice(0, 5)
                .map(shortPath)
                .join(", ")}${
                changedFiles.length > 5 ? ` +${changedFiles.length - 5}` : ""
              }`}
        </span>
        {report &&
          ((report.scenarios?.length ?? 0) > 0 ||
            (report.findings?.length ?? 0) > 0) && (
            <span data-testid="step-artifacts">
              {[
                (report.scenarios?.length ?? 0) > 0
                  ? `${report.scenarios?.length} сценариев`
                  : null,
                (report.findings?.length ?? 0) > 0
                  ? `${report.findings?.length} findings`
                  : null,
              ]
                .filter((part): part is string => part !== null)
                .join(" · ")}
            </span>
          )}
        {run.screenshots_dir && (
          <span data-testid="step-screenshots">
            Скриншоты: {shortPath(run.screenshots_dir)}
          </span>
        )}
      </RunStatsLine>
    </li>
  );
}