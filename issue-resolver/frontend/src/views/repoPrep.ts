export type RepoPrepStatus =
  | 'pending'
  | 'cloning'
  | 'cloned'
  | 'devops'
  | 'installed'
  | 'dev_server'
  | 'ready'
  | 'skipped'
  | 'failed';

export interface RepoPrepStep {
  step: string;
  repo?: string;
  status: 'running' | 'done' | 'warning' | 'error';
  message?: string;
  devPort?: number;
}

export const REPO_PREP_LABELS: Record<RepoPrepStatus, string> = {
  pending: 'в очереди',
  cloning: 'клонирование',
  cloned: 'склонирован',
  devops: 'анализ запуска',
  installed: 'зависимости установлены',
  dev_server: 'запуск dev-сервера',
  ready: 'готов',
  skipped: 'DevOps пропущен',
  failed: 'ошибка',
};

export const REPO_PREP_MARKS: Record<RepoPrepStatus, string> = {
  pending: '🟡',
  cloning: '🔵',
  cloned: '🔵',
  devops: '🟣',
  installed: '🟢',
  dev_server: '🔷',
  ready: '✅',
  skipped: '⏭️',
  failed: '❌',
};

export const REPO_PREP_COLORS: Record<RepoPrepStatus, string> = {
  pending: '#FFB000',
  cloning: '#00B4FF',
  cloned: '#00B4FF',
  devops: '#9D7CFF',
  installed: '#00FF41',
  dev_server: '#00B4FF',
  ready: '#00FF41',
  skipped: '#8A8A8A',
  failed: '#FF0033',
};

export function repoFullNameFromUrl(url: string): string {
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
  if (own.some((step) => step.status === 'error')) return 'failed';

  const skipped = !bootstrapEnabled || own.some((step) => step.message === 'пропущен');
  if (workspaceReady) return skipped ? 'skipped' : 'ready';

  const devServer = lastStep(own, 'dev_server');
  if (devServer) {
    if (skipped) return 'skipped';
    if (devServer.status === 'running') return 'dev_server';
    return 'installed';
  }

  if (lastStep(own, 'installing')) return skipped ? 'skipped' : 'installed';
  if (lastStep(own, 'devops')) {
    return skipped ? 'skipped' : 'devops';
  }
  if (lastStep(own, 'checking_instructions')) return 'cloned';

  const cloning = lastStep(own, 'cloning');
  if (cloning) return cloning.status === 'running' ? 'cloning' : 'cloned';

  return 'pending';
}

export function repoDevPort(
  repoKey: string,
  steps: readonly RepoPrepStep[],
): number | undefined {
  const own = steps.filter((step) => step.repo === repoKey);
  const devServer = lastStep(own, 'dev_server');
  return devServer?.status === 'done' ? devServer.devPort : undefined;
}