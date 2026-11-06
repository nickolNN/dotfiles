import {
  RetroRunStatus,
  StepAgentStatus,
  StepRunStatus,
  TaskStatus,
} from '@issue-resolver/shared';

export const MATRIX = {
  bg: '#0D0208',
  panel: '#003B00',
  border: '#008F11',
  green: '#00FF41',
} as const;

export const statusColor: Record<TaskStatus, string> = {
  [TaskStatus.draft]: '#8A8A8A',
  [TaskStatus.pending]: '#008F11',
  [TaskStatus.running]: '#00B4FF',
  [TaskStatus.preparing]: '#FFB000',
  [TaskStatus.completed]: '#00FF41',
  [TaskStatus.failed]: '#FF0033',
  [TaskStatus.cancelled]: '#8A8A8A',
  [TaskStatus.question]: '#FFB000',
};

export const stepStatusColor: Record<StepRunStatus, string> = {
  [StepRunStatus.pending]: '#008F11',
  [StepRunStatus.running]: '#00B4FF',
  [StepRunStatus.success]: '#00FF41',
  [StepRunStatus.failed]: '#FF0033',
  [StepRunStatus.aborted]: '#FF0033',
  [StepRunStatus.needs_input]: '#FFB000',
  [StepRunStatus.skipped]: '#8A8A8A',
};

export const agentStatusColor: Record<StepAgentStatus, string> = {
  [StepAgentStatus.running]: '#00FF41',
  [StepAgentStatus.finished]: '#00FF41',
  [StepAgentStatus.aborted]: '#FF0033',
  [StepAgentStatus.failed]: '#FF0033',
};

export const retroStatusColor: Record<RetroRunStatus, string> = {
  [RetroRunStatus.running]: '#FFB000',
  [RetroRunStatus.success]: '#00FF41',
  [RetroRunStatus.failed]: '#FF0033',
};
