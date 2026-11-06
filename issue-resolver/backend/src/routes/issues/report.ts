import { join } from 'node:path';
import {
  extractRepoNameFromUrl,
  IssueRunKind,
  PipelineStep,
  RunState,
  SessionAddress,
  StepRunStatus,
  isThinkingLevel,
} from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import type { IssuesContext } from './context';
import { iterations } from '../../db/schema';
import {
  getLatestStepRunForIssue,
  getStepRunWithLog,
} from '../../db/step-runs.repo';
import { buildStepPrompt } from '../../workflow/prompts';
import {
  isReportRunActive,
  lastReportFailed,
  observedModelFor,
  rebuildReportPage,
  refreshLatestResultSnapshot,
  reportModelFor,
  reportWarningsFor,
  runReportAgent,
} from '../../workflow/run-iteration.service';
import {
  containerNameFor,
  DEFAULT_WORKSPACE_ROOT,
  workspaceContainerDirFor,
  workspaceHostDirFor,
} from '../../workspace/paths';
import { ROUTE_PATH } from './paths';
import { messageOf } from '../../util/errors';
import { asRecord } from '../../util/records';
import { stringOrNull } from '../../util/scalars';
import { conflict, notFound } from '../params';
import { abortStaleRun, runStatusPayload, statusFromRun } from './latest-run';

async function reportArtifactsOnDisk(hostDir: string): Promise<{
  md: { present: boolean; bytes: number; mtime: string | null };
  html: { present: boolean; bytes: number; mtime: string | null };
}> {
  const { stat } = await import('node:fs/promises');
  const read = async (name: string) => {
    try {
      const file = await stat(join(hostDir, name));
      return {
        present: file.size > 0,
        bytes: file.size,
        mtime: file.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
    } catch {
      return { present: false, bytes: 0, mtime: null };
    }
  };
  return { md: await read('report.md'), html: await read('report.html') };
}


export function registerIssueReport(ctx: IssuesContext): void {
  const { app, db, deps, service, config } = ctx;
  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/report`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }

      if (isReportRunActive(id)) {
        return conflict(reply, 'report run already active');
      }

      const reportRunId = SessionAddress.forIssueRun(
        id,
        IssueRunKind.report,
      ).toString();
      const wsRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
      const hostDir = workspaceHostDirFor(wsRoot, id);
      const containerName = containerNameFor(id);

      const repoWorkspaces = (issue.repositories ?? []).map((repo) => {
        const repoName = extractRepoNameFromUrl(repo.repository_url);
        return `/${repoName}`;
      });

      const iterationRows = db
        .select({ number: iterations.number })
        .from(iterations)
        .where(eq(iterations.issue_id, id))
        .all();
      const iterationCount = iterationRows.length > 0
        ? Math.max(...iterationRows.map((r) => r.number))
        : 0;

      try {
        const prompt = buildStepPrompt({
          step: PipelineStep.report,
          issueTitle: issue.title,
          description: issue.description ?? '',
          jiraText: null,
          context: `Task completed. Iterations: ${iterationCount}.`,
          feedback: null,
          repoPaths: repoWorkspaces,
          iterationCount,
          workingDir: deps.local ? hostDir : workspaceContainerDirFor(id),
        });

        const query = asRecord(request.query);
        void runReportAgent({ ...deps, db }, {
          issueId: id,
          containerName,
          hostDir,
          prompt,
          model: stringOrNull(query?.model) || reportModelFor(db, id),
          thinkingLevel: isThinkingLevel(query?.thinking)
            ? query.thinking
            : undefined,
          trigger: 'manual',
          origin: request.headers.origin ?? null,
        }).then(() =>
          refreshLatestResultSnapshot(db, deps.workspaceRoot, id).catch(
            (error) => console.error('refresh report snapshot failed', error),
          ),
        );

        return reply.code(202).send({ ok: true, reportRunId });
      } catch (error) {
        const message = messageOf(error);
        return reply.status(500).send({ error: message });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/report/status`,
    async (request, reply) => {
      const { id } = request.params;
      if (!service.getIssue(db, config, id)) {
        return notFound(reply, 'issue not found');
      }

      const wsRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
      const hostDir = workspaceHostDirFor(wsRoot, id);
      const artifacts = await reportArtifactsOnDisk(hostDir);
      const run = await getLatestStepRunForIssue(db, id, PipelineStep.report);
      const active = isReportRunActive(id);
      await abortStaleRun(db, run, {
        label: IssueRunKind.report,
        active,
        now: Date.now(),
      });

      let status: RunState;
      const fromRun = statusFromRun(run, active);
      if (fromRun) status = fromRun;
      else if (artifacts.md.present) status = RunState.success;
      else status = lastReportFailed(id) ? RunState.failed : RunState.idle;

      const warnings = reportWarningsFor(id, hostDir);
      const observedModel = observedModelFor(id);
      return {
        status,
        ...runStatusPayload(run),
        artifacts,
        ...(artifacts.md.mtime ? { lastRunAt: artifacts.md.mtime } : {}),
        ...(observedModel ? { observedModel } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/report/reembed`,
    async (request, reply) => {
      const { id } = request.params;
      if (!service.getIssue(db, config, id)) {
        return notFound(reply, 'issue not found');
      }
      if (isReportRunActive(id)) {
        return conflict(reply, 'report run already active');
      }
      const hostDir = workspaceHostDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        id,
      );
      const artifacts = await reportArtifactsOnDisk(hostDir);
      if (!artifacts.md.present) {
        return conflict(reply, 'report.md отсутствует — пересобирать нечего');
      }
      const rebuilt = await rebuildReportPage(id, hostDir);
      if (!rebuilt.ok) {
        return reply.status(422).send({
          error: 'страница не собрана',
          warnings: rebuilt.warnings,
        });
      }
      return reply.send({
        ok: true,
        embed: rebuilt.embed,
        warnings: rebuilt.warnings,
        artifacts: await reportArtifactsOnDisk(hostDir),
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/report/run`,
    async (request, reply) => {
      const { id } = request.params;
      if (!service.getIssue(db, config, id)) {
        return notFound(reply, 'issue not found');
      }
      const run = await getLatestStepRunForIssue(db, id, PipelineStep.report);
      if (!run) return notFound(reply, 'report run not found');
      await abortStaleRun(db, run, {
        label: IssueRunKind.report,
        active: isReportRunActive(id),
        now: Date.now(),
      });
      const withLog = await getStepRunWithLog(db, run.id);
      if (!withLog) {
        return notFound(reply, 'report run not found');
      }
      return withLog;
    },
  );
}
