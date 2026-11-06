import type { Issue, StepRunWithLog } from '@issue-resolver/shared';
import type { AsyncState } from '../../lib/async-state';

export interface TasksListProps {
  onOpenTask?: (issueId: string) => void;
  onOpenResult?: (issueId: string) => void;
}

export type IssueWithActiveStep = Issue & {
  activeStep?: string;
  activeModel?: string | null;
};

export type LoadState = AsyncState<IssueWithActiveStep[]>;

export const RepoReadiness = Object.freeze({
  ready: 'ready',
  connected: 'connected',
  waiting: 'waiting',
  error: 'error',
} as const);
export type RepoReadiness = (typeof RepoReadiness)[keyof typeof RepoReadiness];

export interface IssueStatsData {
  iterations: number;
  runs: StepRunWithLog[] | null;
  tokensInput: number;
  tokensOutput: number;
  tokensCache: number;
  hasTokenStats: boolean;
  avgSpeed: number | null;
}

export type IssueStatsState = AsyncState<IssueStatsData>;

export interface CardActions {
  open: (issueId: string) => void;
  openResult: (issueId: string) => void;
  remove: (issueId: string) => void;
  stopDevServers: (issueId: string) => void;
}
