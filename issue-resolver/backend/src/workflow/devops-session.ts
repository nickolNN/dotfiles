import { eq } from 'drizzle-orm';
import {
  PipelineStep,
  SESSION_HEARTBEAT_MS,
  StepReportStatus,
  StepRunStatus,
  extractRepoNameFromUrl,
} from '@issue-resolver/shared';
import type { SessionStats } from '@issue-resolver/shared';
import { getTag } from '../db/tags.repo';
import { issues } from '../db/schema';
import {
  appendStepRunEvent,
  createStepRun,
  listStepRunsByIssue,
  updateStepRun,
} from '../db/step-runs.repo';
import type { Db } from '../db/client';
import { capSessionEvents } from '../pi/session-events-cap';
import { startAgentSession } from '../pi/agent-session';
import type { AgentSession } from '../pi/agent-session';
import type { StepSessionRegistry } from '../pi/session-registry';
import type { SseHub } from '../sse/hub';
import { stepStatusEvent } from './sse-events';
import { persistStepRunResult } from './step-run-persist';
import { createActiveRuns } from '../util/active-runs';
import type { DevopsModelSettings } from './run-deps';

export interface DevOpsRunRepos {
  repository_url: string;
  bootstrap_enabled?: boolean;
}

export interface DevOpsContext {
  tagInstructions: string | null;
  reposNames: string | null;
  reposRequireDevServer: string | null;
  reposInstructions: string | null;
}

export function collectDevOpsContext(
  db: Db,
  issueId: string,
  repositories: DevOpsRunRepos[],
): DevOpsContext {
  const issueRow = db
    .select({ tag_id: issues.tag_id })
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  const tag = issueRow?.tag_id ? getTag(db, issueRow.tag_id) : undefined;

  if (tag) {
    return {
      tagInstructions: tag.run_instructions ?? null,
      reposNames:
        tag.repositories
          .map((tr) => extractRepoNameFromUrl(tr.repository.url))
          .join(', ') || null,
      reposRequireDevServer:
        tag.repositories
          .filter((tr) => tr.bootstrap_enabled)
          .map((tr) => extractRepoNameFromUrl(tr.repository.url))
          .join(', ') || null,
      reposInstructions: tag.repositories
        .map((tr) => {
          const name = extractRepoNameFromUrl(tr.repository.url);
          const instr = tr.repository.runInstructions?.trim();
          return `### ${name}\n${instr || '(no instructions)'}`;
        })
        .join('\n\n'),
    };
  }

  return {
    tagInstructions: null,
    reposNames:
      repositories
        .map((r) => extractRepoNameFromUrl(r.repository_url))
        .join(', ') || null,
    reposRequireDevServer:
      repositories
        .filter((r) => r.bootstrap_enabled !== false)
        .map((r) => extractRepoNameFromUrl(r.repository_url))
        .join(', ') || null,
    reposInstructions: null,
  };
}

const activeDevopsRuns = createActiveRuns();

export function isDevopsRunActive(issueId: string): boolean {
  return activeDevopsRuns.has(issueId);
}

export const DEVOPS_RUN_HEARTBEAT_MS = SESSION_HEARTBEAT_MS;

interface DevopsSessionHandle {
  stepRunId: string;
  sessionId: string;
  startedAt: number;
  session: AgentSession;
}

export async function startDevopsSession(
  db: Db,
  deps: { sse: SseHub; control?: StepSessionRegistry } &
    Pick<DevopsModelSettings, 'devopsModel'>,
  input: {
    issueId: string;
    iterationId?: string;
    sessionId: string;
    context: string;
    enabled: boolean;
  },
): Promise<DevopsSessionHandle | null> {
  if (!input.enabled) return null;

  const previous = await listStepRunsByIssue(db, input.issueId);
  const stepRun = await createStepRun(db, {
    issueId: input.issueId,
    iterationId: null,
    step: PipelineStep.devops,
    attempt: previous.filter((run) => run.step === PipelineStep.devops).length + 1,
    context: input.context,
  });
  await updateStepRun(db, stepRun.id, { status: StepRunStatus.running });

  const session = startAgentSession(
    {
      sse: deps.sse,
      control: deps.control,
      store: {
        appendStepRunEvent: (id, event) =>
          appendStepRunEvent(db, id, event),
        updateStepRun: (id, patch) => updateStepRun(db, id, patch),
      },
    },
    {
      issueId: input.issueId,
      ...(input.iterationId ? { iterationId: input.iterationId } : {}),
      sessionId: input.sessionId,
      persistStepRunId: stepRun.id,
      heartbeatMs: DEVOPS_RUN_HEARTBEAT_MS,
    },
  );

  deps.sse.publish(
    stepStatusEvent(input.issueId, input.sessionId, StepRunStatus.running, {
      step: PipelineStep.devops,
      model: deps.devopsModel ?? null,
    }),
  );

  activeDevopsRuns.add(input.issueId);
  return {
    stepRunId: stepRun.id,
    sessionId: input.sessionId,
    startedAt: Date.now(),
    session,
  };
}

export async function finishDevopsSession(
  db: Db,
  deps: { sse: SseHub },
  handle: DevopsSessionHandle | null,
  input: {
    issueId: string;
    status: StepRunStatus;
    summary: string;
    feedback?: string | null;
    stats?: SessionStats | null;
  },
): Promise<void> {
  if (!handle) return;
  activeDevopsRuns.delete(input.issueId);
  handle.session.stop();

  const snapshot = handle.session.snapshot();
  await persistStepRunResult(db, handle.stepRunId, {
    label: 'devops',
    status: input.status,
    feedback: input.feedback ?? null,
    report: {
      status:
        input.status === StepRunStatus.success
          ? StepReportStatus.pass
          : StepReportStatus.fail,
      summary: input.summary,
    },
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
    events: capSessionEvents(snapshot.events),
    stats: input.stats ?? snapshot.stats,
  });

  deps.sse.publish(
    stepStatusEvent(input.issueId, handle.sessionId, input.status),
  );
}
