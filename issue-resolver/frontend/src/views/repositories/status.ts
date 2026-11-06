import {
  formatRelativeTime,
  RepoConnectionStatus,
  type SavedRepo,
} from '@issue-resolver/shared';

export const STATUS_META: Record<
  RepoConnectionStatus,
  { color: string; label: string }
> = {
  [RepoConnectionStatus.ok]: { color: '#00FF41', label: 'Соединение в порядке' },
  [RepoConnectionStatus.error]: { color: '#FF0033', label: 'Ошибка соединения' },
  [RepoConnectionStatus.unknown]: { color: '#8A8A8A', label: 'Не проверялось' },
};

export function validatedLabel(repo: SavedRepo): string {
  if (!repo.lastValidatedAt) return 'не проверялся';
  return formatRelativeTime(repo.lastValidatedAt);
}