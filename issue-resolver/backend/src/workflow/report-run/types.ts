import type { StepRunStatus, ThinkingLevel } from '@issue-resolver/shared';
import type { Db } from '../../db/client';
import type { IterationRunDeps } from '../service-contracts';
import type { ReportRunSession } from './step-session';

export type ReportRunDeps = Pick<
  IterationRunDeps,
  'pi' | 'sse' | 'control' | 'workspaceRoot'
> & {
  db: Db;
};

export interface RunReportAgentInput {
  issueId: string;
  containerName: string;
  hostDir: string;
  prompt: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  trigger?: 'post-iteration' | 'manual';
  origin?: string | null;
}

export interface ReportRunState {
  status: StepRunStatus;
  failure: unknown;
  observedModel?: string;
  anchorPath: string | null;
}

export interface ReportRunContext {
  session: ReportRunSession;
  stepRunId: string;
  startedAt: number;
  state: ReportRunState;
}
