import { StepRunStatus } from '@issue-resolver/shared';
import type { SessionEvent } from '@issue-resolver/shared';
import { capSessionEvents } from '../../pi/session-events-cap';
import { reportArtifactsPresent } from '../report-archive';
import { rebuildReportPage } from '../report-page';
import {
  detectModelLeak,
  recordObservedModel,
  recordReportWarnings,
} from '../report-warnings';
import { persistStepRunResult } from '../step-run-persist';
import { recordReportOutcome, unmarkReportRunActive } from './tracking';
import type {
  ReportRunContext,
  ReportRunDeps,
  RunReportAgentInput,
} from './types';
import { messageOf } from '../../util/errors';

export interface SettledReportRun {
  status: StepRunStatus;
  failure: unknown;
}

function feedbackFor(
  status: StepRunStatus,
  failure: unknown,
  hasHtml: boolean,
  rendered: { warnings: string[] },
  truncated: boolean,
): string | null {
  if (status === StepRunStatus.failed) {
    const reason = messageOf(failure);
    return `report failed: ${reason}`;
  }
  if (hasHtml) return null;
  if (truncated) {
    return 'report.html не собран движком: прогон оборван лимитом вывода модели (maxTokens) — ход закончился на размышлении';
  }
  return `страница не собрана: ${rendered.warnings.join('; ') || 'report.md пуст'}`;
}

export async function settleReportRun(
  deps: ReportRunDeps,
  input: RunReportAgentInput,
  ctx: ReportRunContext,
): Promise<SettledReportRun> {
  const { session, stepRunId, state } = ctx;
  unmarkReportRunActive(input.issueId);
  session.stop();
  recordObservedModel(input.issueId, state.observedModel);

  const rebuilt = await rebuildReportPage(input.issueId, input.hostDir);
  const rendered = { html: rebuilt.ok, warnings: rebuilt.warnings };
  if (rebuilt.warnings.some((warning) => warning.startsWith('скриншоты'))) {
    console.warn('report screenshots failed', {
      issueId: input.issueId,
      summary: rebuilt.embed,
    });
  }

  const artifacts = reportArtifactsPresent(input.hostDir);
  if (state.status === StepRunStatus.success && !artifacts.md) {
    state.status = StepRunStatus.failed;
    state.failure = 'report.md отсутствует после прогона';
  }

  if (state.status === StepRunStatus.success) {
    const warnings = [
      ...detectModelLeak(input.hostDir, state.observedModel ?? input.model),
      ...rendered.warnings,
      ...(state.anchorPath
        ? [`anchored on previous report: ${state.anchorPath}`]
        : []),
    ];
    if (warnings.length > 0) {
      recordReportWarnings(input.issueId, warnings);
      console.warn('model id leaked into report artifacts', {
        issueId: input.issueId,
        warnings,
      });
    } else {
      recordReportWarnings(input.issueId, null);
    }
    recordReportOutcome(input.issueId, false);
  } else {
    recordReportOutcome(input.issueId, true);
  }

  const snapshot = session.snapshot();
  const truncated = snapshot.events.some(
    (event: SessionEvent) =>
      event.type === 'notice' && event.message.includes('лимитом вывода'),
  );
  await persistStepRunResult(deps.db, stepRunId, {
    label: 'report',
    status: state.status,
    feedback: feedbackFor(
      state.status,
      state.failure,
      artifacts.html,
      rendered,
      truncated,
    ),
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
    events: capSessionEvents(snapshot.events),
    stats: snapshot.stats,
    report: { artifacts },
  });

  return { status: state.status, failure: state.failure };
}