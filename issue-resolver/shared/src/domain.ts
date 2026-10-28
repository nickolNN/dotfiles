import type { Iteration, TaskStatus } from './types';

export function extractIssueKeyFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  let pathname: string;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    return null;
  }

  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

export function extractRepoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const segments = trimmed.split(/[/:]/).filter((segment) => segment.length > 0);
  const last = segments.length > 0 ? segments[segments.length - 1] : '';
  return last.replace(/\.git$/i, '');
}

function formatQuantity(value: number, unit: string): string {
  return `${Math.max(1, value)} ${unit} назад`;
}

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const diffSeconds = Math.floor(
    (now.getTime() - new Date(iso).getTime()) / 1000,
  );

  if (diffSeconds < 60) return 'только что';

  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return formatQuantity(minutes, 'мин');

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatQuantity(hours, 'ч');

  return formatQuantity(Math.floor(hours / 24), 'дн');
}

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDateTime(iso: string): string {
  return DATE_TIME_FORMATTER.format(new Date(iso));
}

export function statusOfIssue(
  iterations: Iteration[],
  issueStatus?: TaskStatus,
): TaskStatus | null {
  if (issueStatus === 'question') return 'question';
  if (iterations.length === 0) return null;

  const latest = iterations.reduce((max, current) =>
    current.number > max.number ? current : max,
  );
  return latest.status;
}

export function isIterationActive(status: TaskStatus): boolean {
  return status === 'running' || status === 'pending' || status === 'preparing';
}

export function canStartDraft(status: TaskStatus, iterationsCount: number): boolean {
  return status === 'draft' && iterationsCount === 0;
}

export function canStartIteration(iterations: Iteration[]): boolean {
  const status = statusOfIssue(iterations);
  return status === null || !isIterationActive(status);
}