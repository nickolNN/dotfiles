export { formatDuration as formatStepDuration } from '../../lib/time';
export { stepDurationMs } from '../../lib/time';
import {
  ExecutionMode,
  PipelineStep,
  StepRunStatus,
  WorkspaceProgressStatus,
  parseStepReport,
} from '@issue-resolver/shared';
import type {
  IssueFile,
  ModelDescriptor,
  SessionModelInfo,
  StepRunWithLog,
} from '@issue-resolver/shared';
import { isRecord } from '../../api/guards';
import type { SessionEvent } from '../../api/session-events';
import {
  CYCLE_MODEL_ID,
  FILE_CHANGING_TOOLS,
  HARNESS_RESULT_FILE,
  STEP_RUN_STATUSES,
  WORKSPACE_STEP_LABELS,
} from './constants';

export function isMultiAgentIteration(runs: StepRunWithLog[]): boolean {
  const latestRefine = runs
    .filter((run) => run.step === PipelineStep.refine)
    .sort((a, b) => b.attempt - a.attempt)[0];
  const mode = parseStepReport(latestRefine?.report ?? '')?.execution?.mode;
  return mode === ExecutionMode.stages;
}

export function workspaceStepLabel(step: string, repo?: string): string {
  const label = WORKSPACE_STEP_LABELS[step] ?? step;
  return repo ? `${label} ${repo}` : label;
}

export function workspaceStepMark(status: WorkspaceProgressStatus): string {
  switch (status) {
    case WorkspaceProgressStatus.running:
      return '⏳';
    case WorkspaceProgressStatus.done:
      return '✓';
    case WorkspaceProgressStatus.warning:
      return '!';
    case WorkspaceProgressStatus.error:
      return '✕';
  }
}

export function isStepRunStatus(
  value: string | undefined,
): value is StepRunStatus {
  return value !== undefined && STEP_RUN_STATUSES.has(value);
}

export function stepRunMark(status: StepRunStatus): string {
  switch (status) {
    case StepRunStatus.pending:
      return 'pending';
    case StepRunStatus.running:
      return 'active';
    case StepRunStatus.success:
      return '✓';
    case StepRunStatus.failed:
      return '✕';
    case StepRunStatus.aborted:
      return 'aborted';
    case StepRunStatus.needs_input:
      return '!';
    case StepRunStatus.skipped:
      return '—';
  }
}

function toolPathOf(args: unknown): string | null {
  if (!isRecord(args)) return null;
  const { path } = args;
  return typeof path === 'string' && path.length > 0 ? path : null;
}

export function stepChangedFiles(events: SessionEvent[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    if (!FILE_CHANGING_TOOLS.has(event.toolName)) continue;
    const path = toolPathOf(event.args);
    if (path === null || path.endsWith(HARNESS_RESULT_FILE)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  return files;
}

export function filterArtifacts(files: IssueFile[]): IssueFile[] {
  return files.filter((file) => {
    const path = file.rel_path;
    if (
      path.startsWith('node_modules/') ||
      path.startsWith('.git/') ||
      path.startsWith('.yarn/') ||
      path.startsWith('.cache/')
    ) {
      return false;
    }
    const name = file.name;
    if (
      name === 'package-lock.json' ||
      name === 'yarn.lock' ||
      name === 'bun.lockb' ||
      name === 'pnpm-lock.yaml' ||
      name.endsWith('.log')
    ) {
      return false;
    }
    return true;
  });
}

export function controlModelList(models: SessionModelInfo[]): ModelDescriptor[] {
  return [
    ...models.map((model) => ({
      id: model.id,
      provider: model.provider,
      ...(model.name ? { name: model.name } : {}),
    })),
    { id: CYCLE_MODEL_ID, name: '↻ следующая' },
  ];
}