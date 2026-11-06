import { WorkspaceProgressStep, WorkspaceProgressStatus } from '@issue-resolver/shared';

export const RepoPrepStatus = Object.freeze({
  pending: 'pending',
  cloning: 'cloning',
  cloned: 'cloned',
  devops: 'devops',
  installed: 'installed',
  dev_server: 'dev_server',
  ready: 'ready',
  skipped: 'skipped',
  failed: 'failed',
} as const);
export type RepoPrepStatus =
  (typeof RepoPrepStatus)[keyof typeof RepoPrepStatus];

export interface RepoPrepStep {
  step: string;
  repo?: string;
  status: WorkspaceProgressStatus;
  message?: string;
  devPort?: number;
}

export const REPO_PREP_LABELS: Record<RepoPrepStatus, string> = {
  [RepoPrepStatus.pending]: 'в очереди',
  [RepoPrepStatus.cloning]: 'клонирование',
  [RepoPrepStatus.cloned]: 'склонирован',
  [RepoPrepStatus.devops]: 'анализ запуска',
  [RepoPrepStatus.installed]: 'зависимости установлены',
  [RepoPrepStatus.dev_server]: 'запуск dev-сервера',
  [RepoPrepStatus.ready]: 'готов',
  [RepoPrepStatus.skipped]: 'DevOps пропущен',
  [RepoPrepStatus.failed]: 'ошибка',
};

export const REPO_PREP_MARKS: Record<RepoPrepStatus, string> = {
  [RepoPrepStatus.pending]: '🟡',
  [RepoPrepStatus.cloning]: '🔵',
  [RepoPrepStatus.cloned]: '🔵',
  [RepoPrepStatus.devops]: '🟣',
  [RepoPrepStatus.installed]: '🟢',
  [RepoPrepStatus.dev_server]: '🔷',
  [RepoPrepStatus.ready]: '✅',
  [RepoPrepStatus.skipped]: '⏭️',
  [RepoPrepStatus.failed]: '❌',
};

export const REPO_PREP_COLORS: Record<RepoPrepStatus, string> = {
  [RepoPrepStatus.pending]: '#FFB000',
  [RepoPrepStatus.cloning]: '#00B4FF',
  [RepoPrepStatus.cloned]: '#00B4FF',
  [RepoPrepStatus.devops]: '#9D7CFF',
  [RepoPrepStatus.installed]: '#00FF41',
  [RepoPrepStatus.dev_server]: '#00B4FF',
  [RepoPrepStatus.ready]: '#00FF41',
  [RepoPrepStatus.skipped]: '#8A8A8A',
  [RepoPrepStatus.failed]: '#FF0033',
};

export function repoFullNameFromUrl(url: string | null | undefined): string {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim().replace(/\/+$/, '');
  const withoutGit = trimmed.replace(/\.git$/i, '');
  const segments = withoutGit.split(/[/:]/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return trimmed;
  return segments.slice(-2).join('/');
}

function lastStep(
  steps: readonly RepoPrepStep[],
  step: string,
): RepoPrepStep | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].step === step) return steps[index];
  }
  return undefined;
}

export function repoPrepStatus(
  repoKey: string,
  bootstrapEnabled: boolean,
  steps: readonly RepoPrepStep[],
  workspaceReady = false,
): RepoPrepStatus {
  const own = steps.filter((step) => step.repo === repoKey);
  if (own.some((step) => step.status === WorkspaceProgressStatus.error))
    return RepoPrepStatus.failed;

  const skipped = !bootstrapEnabled || own.some((step) => step.message === 'пропущен');
  if (workspaceReady) return skipped ? RepoPrepStatus.skipped : RepoPrepStatus.ready;

  const devServer = lastStep(own, WorkspaceProgressStep.dev_server);
  if (devServer) {
    if (skipped) return RepoPrepStatus.skipped;
    if (devServer.status === WorkspaceProgressStatus.running) return RepoPrepStatus.dev_server;
    return RepoPrepStatus.installed;
  }

  if (lastStep(own, WorkspaceProgressStep.installing))
    return skipped ? RepoPrepStatus.skipped : RepoPrepStatus.installed;
  if (lastStep(own, WorkspaceProgressStep.devops)) {
    return skipped ? RepoPrepStatus.skipped : RepoPrepStatus.devops;
  }
  if (lastStep(own, WorkspaceProgressStep.checking_instructions)) return RepoPrepStatus.cloned;

  const cloning = lastStep(own, WorkspaceProgressStep.cloning);
  if (cloning)
    return cloning.status === WorkspaceProgressStatus.running
      ? RepoPrepStatus.cloning
      : RepoPrepStatus.cloned;

  return RepoPrepStatus.pending;
}

export function repoDevPort(
  repoKey: string,
  steps: readonly RepoPrepStep[],
): number | undefined {
  const own = steps.filter((step) => step.repo === repoKey);
  const devServer = lastStep(own, WorkspaceProgressStep.dev_server);
  return devServer?.status === WorkspaceProgressStatus.done ? devServer.devPort : undefined;
}