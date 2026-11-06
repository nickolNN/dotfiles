import { StepRunStatus, TaskStatus, isIterationActive } from "@issue-resolver/shared";
import type { Iteration } from "@issue-resolver/shared";
import { sessionEventsOf, type SessionEvent } from "../../api/session-events";
import { formatDateTime, formatRelativeTime } from "@issue-resolver/shared";
import IssueFilesList from "../../components/IssueFilesList";
import type { IssueFile } from "@issue-resolver/shared";
import { statusColor, stepStatusColor } from "../../theme";
import { TERMINATED_STATUSES } from "./constants";
import { isActiveStatus, statusOf } from "./status";
import StepRunLog from "./StepRunLog";
import type { StepRunsState } from "./types";
import { stepRunMark } from "./format";
import { AsyncStateStatus } from '../../lib/async-state';

export interface IterationActions {
  aborting: boolean;
  onAbort: (iterationId: string) => void;
  abortError: string | null;
  repeatingId: string | null;
  onRepeat: (iteration: Iteration) => void;
  queueingId: string | null;
  onQueue: (iteration: Iteration) => void;
}

export interface IterationFiles {
  files: IssueFile[];
  onDelete: (fileId: string) => void;
  deletingId: string | null;
}

export interface StepLive {
  statusByRun: Record<string, StepRunStatus>;
  eventsByRun: Record<string, SessionEvent[]>;
  now: number;
  refreshTick: number;
}

interface IterationCardProps {
  iteration: Iteration;
  isSelected: boolean;
  onSelect: (iterationId: string) => void;
  actions: IterationActions;
  files: IterationFiles;
  stepRuns: StepRunsState;
  live: StepLive;
  iterationError: string | undefined;
  agentsIteration: boolean;
  onExpandStep: (runId: string) => void;
}

export default function IterationCard({
  iteration,
  isSelected,
  onSelect,
  actions,
  files,
  stepRuns,
  live,
  iterationError,
  agentsIteration,
  onExpandStep,
}: IterationCardProps) {
  const steps = iteration.steps;

  return (
    <li
      role="button"
      tabIndex={0}
      onClick={() => onSelect(iteration.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(iteration.id);
        }
      }}
      className={`cursor-pointer rounded-none border border-[#008F11] p-4 text-sm transition-base${isSelected ? " ring-1 ring-[#00FF41] bg-[#003B00]/40" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[#00FF41]">Итерация #{iteration.number}</span>
        <span
          className="text-xs uppercase tracking-wider"
          style={{ color: statusColor[iteration.status] }}
        >
          {iteration.status}
        </span>
        <time
          className="text-xs text-[#00FF41]/60"
          dateTime={iteration.created_at}
          title={formatDateTime(iteration.created_at)}
        >
          {formatRelativeTime(iteration.created_at)}
        </time>
        {iteration.status === TaskStatus.running && (
          <button
            type="button"
            data-testid="abort-iteration"
            disabled={actions.aborting}
            onClick={(event) => {
              event.stopPropagation();
              actions.onAbort(iteration.id);
            }}
            className="min-h-8 shrink-0 border border-[#FF0033] bg-[#2A0008] px-3 py-1 text-xs font-medium text-[#FF0033] hover:bg-[#FF0033] hover:text-[#0D0208] disabled:opacity-50 transition-base"
          >
            {actions.aborting ? "Прерываем…" : "Прервать"}
          </button>
        )}
        <button
          type="button"
          data-testid="repeat-iteration"
          disabled={
            actions.repeatingId === iteration.id ||
            isIterationActive(iteration.status)
          }
          onClick={(event) => {
            event.stopPropagation();
            actions.onRepeat(iteration);
          }}
          className="ml-auto min-h-8 shrink-0 border border-[#008F11] bg-[#002B00] px-3 py-1 text-xs font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 transition-base"
        >
          {actions.repeatingId === iteration.id ? "Повторяем…" : "↻ Повторить"}
        </button>
        {iteration.status === TaskStatus.draft && (
          <button
            type="button"
            data-testid="queue-iteration"
            disabled={actions.queueingId === iteration.id}
            onClick={(event) => {
              event.stopPropagation();
              actions.onQueue(iteration);
            }}
            className="min-h-8 shrink-0 border border-[#00FF41] bg-[#002B00] px-3 py-1 text-xs font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 transition-base"
          >
            {actions.queueingId === iteration.id ? "В очереди…" : "▶ В очередь"}
          </button>
        )}
      </div>

      {iteration.status === TaskStatus.running && actions.abortError && (
        <p role="alert" className="mt-2 text-xs font-medium text-[#FF0033]">
          {actions.abortError}
        </p>
      )}

      {iteration.context && (
        <p className="mt-2 whitespace-pre-wrap break-words text-[#00FF41]/80">
          {iteration.context}
        </p>
      )}

      <IssueFilesList
        files={files.files.filter((file) => file.iteration_id === iteration.id)}
        onDelete={files.onDelete}
        deletingId={files.deletingId}
      />

      {steps.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {(() => {
            let terminated = false;
            return steps.map((step) => {
              if (!isSelected) {
                return (
                  <li
                    key={step}
                    className="border border-[#008F11] px-2 py-0.5 text-xs text-[#00FF41]/80"
                  >
                    {step}
                  </li>
                );
              }
              const run =
                stepRuns.status === AsyncStateStatus.ready
                  ? stepRuns.data
                      .filter((candidate) => candidate.step === step)
                      .sort((a, b) => b.attempt - a.attempt)[0]
                  : undefined;
              let status: StepRunStatus = StepRunStatus.pending;
              if (terminated) {
                status = StepRunStatus.skipped;
              } else if (run) {
                status = statusOf(run, live.statusByRun);
              }
              if (TERMINATED_STATUSES.has(status)) {
                terminated = true;
              }
              const active = isActiveStatus(status);
              return (
                <li
                  key={step}
                  data-testid={`step-chip-${step}`}
                  data-status={status}
                  className={`flex items-center gap-1 border px-2 py-0.5 text-xs${
                    active
                      ? " animate-pulse-subtle border-[#00FF41] text-[#00FF41]"
                      : " border-[#008F11]"
                  }`}
                  style={active ? undefined : { color: stepStatusColor[status] }}
                >
                  <span className="transition-base">{step}</span>
                  <span aria-hidden="true">{stepRunMark(status)}</span>
                </li>
              );
            });
          })()}
        </ul>
      )}

      {isSelected && (
        <div
          data-testid="iteration-steps"
          className="mt-3 border-t border-[#008F11]/40 pt-3"
        >
          {iterationError && (
            <p
              role="alert"
              data-testid="iteration-error"
              className="mb-3 border border-[#FF0033] bg-[#2A0008] px-3 py-2 text-xs font-medium text-[#FF0033]"
            >
              ❌ Ошибка подготовки: {iterationError}
            </p>
          )}
          <h4 className="mb-2 text-xs uppercase tracking-wider text-[#00FF41]/60">
            Шаги
          </h4>
          {stepRuns.status === AsyncStateStatus.loading && (
            <p className="text-xs text-[#00FF41]/60">Загрузка шагов…</p>
          )}
          {stepRuns.status === AsyncStateStatus.error && (
            <p role="alert" className="text-xs font-medium text-[#FF0033]">
              Не удалось загрузить шаги: {stepRuns.message}
            </p>
          )}
          {stepRuns.status === AsyncStateStatus.empty && (
            <p className="text-xs text-[#00FF41]/60">Шагов пока нет</p>
          )}
          {stepRuns.status === AsyncStateStatus.ready && (
            <ul className="space-y-3">
              {stepRuns.data.map((run) => (
                <StepRunLog
                  key={run.id}
                  run={run}
                  events={[
                    ...sessionEventsOf(run),
                    ...(live.eventsByRun[run.id] ?? []),
                  ]}
                  status={statusOf(run, live.statusByRun)}
                  now={live.now}
                  agentsIteration={agentsIteration}
                  refreshTick={live.refreshTick}
                  onExpand={onExpandStep}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}