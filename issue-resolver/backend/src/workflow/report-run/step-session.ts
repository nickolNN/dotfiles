import { appendStepRunEvent, updateStepRun } from '../../db/step-runs.repo';
import { startAgentSession } from '../../pi/agent-session';
import { anchoredPreviousReportPath } from '../report-warnings';
import { REPORT_RUN_HEARTBEAT_MS } from './tracking';
import type { ReportRunDeps, RunReportAgentInput } from './types';

export type ReportRunSession = ReturnType<typeof startAgentSession>;

export interface ReportRunSessionInput {
  deps: ReportRunDeps;
  input: RunReportAgentInput;
  stepRunId: string;
  reportRunId: string;
  onAnchor: (path: string) => void;
}

export function createReportSession({
  deps,
  input,
  stepRunId,
  reportRunId,
  onAnchor,
}: ReportRunSessionInput): ReportRunSession {
  const anchor: { path: string | null } = { path: null };
  return startAgentSession(
    {
      sse: deps.sse,
      store: {
        appendStepRunEvent: (id, event) =>
          appendStepRunEvent(deps.db, id, event),
        updateStepRun: (id, patch) => updateStepRun(deps.db, id, patch),
      },
    },
    {
      issueId: input.issueId,
      sessionId: reportRunId,
      persistStepRunId: stepRunId,
      heartbeatMs: REPORT_RUN_HEARTBEAT_MS,
      onEvent: (event) => {
        if (anchor.path === null) {
          anchor.path = anchoredPreviousReportPath(event);
          if (anchor.path !== null) onAnchor(anchor.path);
        }
      },
    },
  );
}