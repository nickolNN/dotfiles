import {
  IssueRunKind,
  PipelineStep,
  RunState,
  SessionAddress,
} from '@issue-resolver/shared';
import type { IssuesContext } from './context';
import {
  getLatestStepRunForIssue,
  getStepRunWithLog,
} from '../../db/step-runs.repo';
import { isDevopsRunActive, runDevopsAgent } from '../../workflow/run-iteration.service';
import { ROUTE_PATH } from './paths';
import { badRequest, conflict, notFound } from '../params';
import { abortStaleRun, runStatusPayload, statusFromRun } from './latest-run';

export function registerIssueDevops(ctx: IssuesContext): void {
  const { app, db, deps, service, config } = ctx;

  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/devops`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }

      const devopsFactory = deps.devopsFactory;
      if (!devopsFactory) {
        return badRequest(reply, 'devops factory not configured');
      }

      if (isDevopsRunActive(id)) {
        return conflict(reply, 'devops run already active');
      }

      const devopsRunId = SessionAddress.forIssueRun(
        id,
        IssueRunKind.devops,
      ).toString();

      void runDevopsAgent({ ...deps, db, devopsFactory }, {
        issueId: id,
        repositories: issue.repositories ?? [],
        trigger: 'manual',
      }).catch((error) =>
        console.error('devops run failed', { issueId: id, error }),
      );

      return reply.code(202).send({ ok: true, devopsRunId });
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/devops/status`,
    async (request, reply) => {
      const { id } = request.params;
      if (!service.getIssue(db, config, id)) {
        return notFound(reply, 'issue not found');
      }

      const run = await getLatestStepRunForIssue(db, id, PipelineStep.devops);
      const active = isDevopsRunActive(id);
      await abortStaleRun(db, run, {
        label: IssueRunKind.devops,
        active,
        now: Date.now(),
      });
      const status = statusFromRun(run, active) ?? RunState.idle;

      return {
        status,
        ...runStatusPayload(run),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/devops/run`,
    async (request, reply) => {
      const { id } = request.params;
      if (!service.getIssue(db, config, id)) {
        return notFound(reply, 'issue not found');
      }
      const run = await getLatestStepRunForIssue(db, id, PipelineStep.devops);
      if (!run) {
        return notFound(reply, 'devops run not found');
      }
      await abortStaleRun(db, run, {
        label: IssueRunKind.devops,
        active: isDevopsRunActive(id),
        now: Date.now(),
      });
      const withLog = await getStepRunWithLog(db, run.id);
      if (!withLog) {
        return notFound(reply, 'devops run not found');
      }
      return withLog;
    },
  );
}
