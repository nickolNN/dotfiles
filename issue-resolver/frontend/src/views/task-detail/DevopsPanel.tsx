import {
  RunState,
  StepRunStatus,
  type StepRunWithLog,
} from "@issue-resolver/shared";
import type { DevopsStatus } from "../../api/client";
import { sessionEventsOf, type SessionEvent } from "../../api/session-events";
import RunOutcome from "../../components/RunOutcome";
import RunStatsLine from "../../components/RunStatsLine";
import { resolveFooter } from "../../components/SessionStatsBar";
import { formatStepDuration, stepDurationMs } from "./format";

export interface DevopsPanelProps {
  phase: DevopsStatus["status"];
  statusInfo: DevopsStatus | null;
  runLog: StepRunWithLog | null;
  events: SessionEvent[];
  starting: boolean;
  error: string | null;
  actions: {
    onRefresh: () => void;
    onOpenOutput: () => void;
  };
}

export default function DevopsPanel({
  phase: devopsPhase,
  statusInfo: devopsStatusInfo,
  runLog: devopsRunLog,
  events: devopsEvents,
  starting: devopsStarting,
  error: devopsError,
  actions,
}: DevopsPanelProps) {
  const finishedEvents = devopsRunLog
    ? [...sessionEventsOf(devopsRunLog), ...devopsEvents]
    : devopsEvents;
  const finishedStats = devopsRunLog?.stats ?? null;

  return (
    <div
      data-testid="devops-section"
      className="mt-3 border border-[#008F11] bg-[#002B00]/30 px-3 py-2"
    >
      <div
        data-testid="devops-controls"
        className="flex flex-wrap items-center gap-2 text-xs"
      >
        <h4 className="uppercase tracking-wider text-[#00FF41]/60">
          DevOps задачи
        </h4>
        {devopsPhase === RunState.idle && (
          <span data-testid="devops-idle" className="text-[#00FF41]/40">
            инструкции не собирались
          </span>
        )}
        {devopsPhase === RunState.running && (
          <span data-testid="devops-running" className="animate-pulse text-[#FFB000]">
            собирает RUN_INSTRUCTIONS.md…
          </span>
        )}
        {devopsPhase === RunState.success && (
          <span data-testid="devops-success" className="text-[#00FF41]">
            ✓ инструкции собраны
            {devopsRunLog ? ` (попытка ${devopsRunLog.attempt})` : ""}
          </span>
        )}
        {devopsPhase === RunState.failed && (
          <span data-testid="devops-failed" className="text-[#FF0033]">
            ✗ {devopsStatusInfo?.feedback ?? "сборка не удалась"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-testid="devops-restart"
            disabled={devopsStarting || devopsPhase === RunState.running}
            onClick={() => void actions.onRefresh()}
            className="border border-[#9D7CFF] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#9D7CFF] hover:bg-[#9D7CFF] hover:text-[#0D0208] disabled:cursor-not-allowed disabled:opacity-40 transition-base"
          >
            {devopsStarting || devopsPhase === RunState.running
              ? "Запущено…"
              : "⟳ Пересобрать"}
          </button>
          {devopsRunLog && devopsPhase !== RunState.running && (
            <button
              type="button"
              data-testid="devops-expand"
              onClick={actions.onOpenOutput}
              className="shrink-0 border border-[#008F11] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] transition-base"
            >
              Развернуть
            </button>
          )}
        </div>
      </div>
      {devopsError && (
        <p
          role="alert"
          data-testid="devops-error"
          className="mt-1 text-xs font-medium text-[#FF0033]"
        >
          {devopsError}
        </p>
      )}
      {devopsPhase === RunState.running && devopsEvents.length > 0 && (
        <RunOutcome
          prefix="devops"
          status={StepRunStatus.running}
          events={devopsEvents}
          stats={devopsRunLog?.stats ?? null}
          report={null}
          startedAt={devopsRunLog?.created_at}
          live
          liveTestId="devops-live"
          liveClassName="mt-2 h-[220px] overflow-auto border border-[#008F11] bg-[#000200] p-2"
        />
      )}
      {devopsRunLog && devopsPhase !== RunState.running && (
        <>
          <RunOutcome
            prefix="devops"
            status={devopsRunLog.status}
            events={finishedEvents}
            stats={finishedStats}
            report={null}
            startedAt={devopsRunLog.created_at}
            body={
              <p className="whitespace-pre-wrap break-words text-[#00FF41]/80">
                {devopsRunLog.status === StepRunStatus.success
                  ? `RUN_INSTRUCTIONS.md собран${
                      devopsRunLog.attempt > 1
                        ? ` с попытки ${devopsRunLog.attempt}`
                        : ""
                    }`
                  : (devopsStatusInfo?.feedback ?? "сборка не удалась")}
              </p>
            }
          />
          <RunStatsLine
            prefix="devops"
            duration={formatStepDuration(
              stepDurationMs(devopsRunLog, false, Date.now()),
            )}
            cost={finishedStats?.cost ?? null}
            footer={resolveFooter(finishedEvents, finishedStats)}
          />
        </>
      )}
    </div>
  );
}
