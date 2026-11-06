import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import type { IssueService } from '../issues/service';
import type { JiraClient } from '../jira/client';
import type { IterationRunDeps } from '../workflow/run-iteration.service';
import { registerIssueArtifacts } from './issues/artifacts';
import { registerIssueAttachments } from './issues/attachments';
import { issuesContext } from './issues/context';
import { registerIssueCreate } from './issues/issue-create';
import { registerIssueCrud } from './issues/issue-crud';
import { registerIssueStart } from './issues/issue-start';
import { registerIssueDevops } from './issues/devops';
import { registerIssueIterations } from './issues/iterations';
import { registerIssueJira } from './issues/jira';
import { registerIssueReport } from './issues/report';
import { registerIssueRuntime } from './issues/runtime';

export async function issuesRoutes(
  app: FastifyInstance,
  db: Db,
  deps: IterationRunDeps,
  jira: JiraClient,
  service: IssueService,
): Promise<void> {
  const ctx = issuesContext(app, db, deps, jira, service);

  registerIssueCrud(ctx);
  registerIssueRuntime(ctx);
  registerIssueJira(ctx);
  registerIssueArtifacts(ctx);
  registerIssueReport(ctx);
  registerIssueDevops(ctx);
  registerIssueIterations(ctx);
  registerIssueAttachments(ctx);
  registerIssueCreate(ctx);
  registerIssueStart(ctx);
}