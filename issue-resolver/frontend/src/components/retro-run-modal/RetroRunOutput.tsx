import { useEffect, useState } from 'react';
import { RetroRunStatus } from '@issue-resolver/shared';
import { formatDuration } from '../../lib/time';
import AgentMarkdown from '../AgentMarkdown';
import RunOutcome from '../RunOutcome';
import RunStatsLine from '../RunStatsLine';
import { resolveFooter } from '../SessionStatsBar';
import { RUN_STATUS } from './status';
import type { RetroRunState } from './useRetroRun';

interface RetroRunOutputProps {
  state: RetroRunState;
}

function runDurationMs(createdAt: string, updatedAt: string): number | null {
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - start;
}

export default function RetroRunOutput({ state }: RetroRunOutputProps) {
  const { log, logRef, error, run, handleDownload } = state;
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  const runId = run?.id ?? null;
  useEffect(() => {
    setTranscriptOpen(false);
  }, [runId]);

  const errorBlock = error ? (
    <p role="alert" data-testid="retro-error" className="text-sm text-[#FF3B3B]">
      {error}
    </p>
  ) : null;

  if (!run) return errorBlock;

  const live = run.status === RetroRunStatus.running;
  const status = RUN_STATUS[run.status];

  const logBlock = log ? (
    <pre
      ref={logRef}
      data-testid="retro-log"
      className="max-h-48 overflow-auto whitespace-pre-wrap border border-[#008F11]/40 bg-black/40 p-2 text-xs text-[#00FF41]/80"
    >
      {log}
    </pre>
  ) : null;

  const runErrorBlock = run.error ? (
    <p data-testid="retro-run-error" className="text-sm text-[#FF3B3B]">
      {run.error}
    </p>
  ) : null;

  const reportBlock = run.report ? (
    <div data-testid="retro-report" className="max-h-96 overflow-auto">
      <AgentMarkdown>{run.report}</AgentMarkdown>
    </div>
  ) : null;

  const body =
    runErrorBlock || reportBlock ? (
      <div className="space-y-2">
        {runErrorBlock}
        {reportBlock}
      </div>
    ) : undefined;

  const expandButton = logBlock ? (
    <button
      type="button"
      data-testid="retro-expand"
      aria-expanded={transcriptOpen}
      className="border border-[#008F11]/60 px-2 py-1 text-xs text-[#00FF41]/80 hover:bg-[#008F11]/10"
      onClick={() => setTranscriptOpen((open) => !open)}
    >
      {transcriptOpen ? 'Свернуть' : 'Развернуть'}
    </button>
  ) : null;

  const downloadButton = run.report ? (
    <button
      type="button"
      data-testid="retro-download"
      className="border border-[#008F11]/60 px-2 py-1 text-xs text-[#00FF41]/80 hover:bg-[#008F11]/10"
      onClick={handleDownload}
    >
      Скачать .md
    </button>
  ) : null;

  const headerExtra =
    expandButton || downloadButton ? (
      <div className="flex items-center gap-2">
        {expandButton}
        {downloadButton}
      </div>
    ) : null;

  return (
    <>
      {errorBlock}

      {live ? (
        <RunOutcome
          prefix="retro"
          status={status}
          events={run.events}
          stats={run.stats}
          report={null}
          startedAt={run.created_at}
          live
          liveView={logBlock}
        />
      ) : (
        <>
          <RunOutcome
            prefix="retro"
            status={status}
            events={run.events}
            stats={run.stats}
            report={null}
            startedAt={run.created_at}
            body={body}
            headerExtra={headerExtra}
          />
          <RunStatsLine
            prefix="retro"
            duration={formatDuration(
              runDurationMs(run.created_at, run.updated_at),
            )}
            cost={run.stats?.cost ?? null}
            costEstimate={run.stats?.costFromProvider !== true}
            footer={resolveFooter(run.events, run.stats)}
          />
          {transcriptOpen && <div className="mt-2">{logBlock}</div>}
        </>
      )}
    </>
  );
}