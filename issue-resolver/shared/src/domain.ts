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

export interface RepositoryRef {
  host: string;
  project: string | null;
  repo: string;
}

function pathSegments(value: string): string[] {
  return value
    .split('/')
    .map((segment) => segment.replace(/\.git$/i, ''))
    .filter((segment) => segment.length > 0);
}

function splitRepositoryUrl(
  url: string,
): { host: string; segments: string[] } | null {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return null;

  const scp = /^(?:[^@/]+@)([^:/]+):(.+)$/.exec(trimmed);
  if (scp) {
    return { host: scp[1], segments: pathSegments(scp[2]) };
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    return {
      host: parsed.hostname,
      segments: pathSegments(decodeURIComponent(parsed.pathname)),
    };
  } catch {
    return null;
  }
}

export function parseRepositoryUrl(url: string): RepositoryRef | null {
  const parts = splitRepositoryUrl(url);
  if (!parts || parts.segments.length === 0) return null;

  const host = parts.host.toLowerCase();
  const lowered = parts.segments.map((segment) => segment.toLowerCase());

  const reposAt = lowered.indexOf('repos');
  if (
    lowered[0] === 'projects' &&
    reposAt >= 1 &&
    reposAt + 1 < lowered.length
  ) {
    return {
      host,
      project: parts.segments[reposAt - 1],
      repo: parts.segments[reposAt + 1],
    };
  }

  if (lowered[0] === 'scm' && lowered.length >= 3) {
    return { host, project: parts.segments[1], repo: parts.segments[2] };
  }

  const gitAt = lowered.indexOf('_git');
  if (gitAt >= 1 && gitAt + 1 < lowered.length) {
    return {
      host,
      project: parts.segments[gitAt - 1],
      repo: parts.segments[gitAt + 1],
    };
  }

  const last = parts.segments.length - 1;
  return {
    host,
    project: last > 0 ? parts.segments[last - 1] : null,
    repo: parts.segments[last],
  };
}

export function repositoryIdentity(url: string): string {
  const ref = parseRepositoryUrl(url);
  if (!ref) return url.trim().replace(/\/+$/, '').toLowerCase();

  const segments = [ref.host, ref.project, ref.repo].filter(
    (segment): segment is string => Boolean(segment),
  );
  return segments.map((segment) => segment.toLowerCase()).join('/');
}

export function isSameRepository(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false;
  return repositoryIdentity(a) === repositoryIdentity(b);
}

export function extractRepoNameFromUrl(url: string): string {
  const parsed = parseRepositoryUrl(url);
  if (parsed) return parsed.repo;

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