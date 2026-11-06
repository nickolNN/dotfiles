
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client';
import type { IssueService, IssueServiceConfig } from '../../issues/service';
import type { JiraClient } from '../../jira/client';
import type { IterationRunDeps } from '../../workflow/run-iteration.service';

export interface IssuesContext {
  app: FastifyInstance;
  db: Db;
  deps: IterationRunDeps;
  jira: JiraClient;
  service: IssueService;
  config: IssueServiceConfig;
}

export function issuesContext(
  app: FastifyInstance,
  db: Db,
  deps: IterationRunDeps,
  jira: JiraClient,
  service: IssueService,
): IssuesContext {
  return { app, db, deps, jira, service, config: service.resolveConfig(deps) };
}
