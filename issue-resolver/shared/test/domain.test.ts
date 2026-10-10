import { describe, expect, it } from 'vitest';

import {
  canStartIteration,
  extractIssueKeyFromUrl,
  extractRepoNameFromUrl,
  formatDateTime,
  formatRelativeTime,
  statusOfIssue,
} from '../src/domain';
import type { Iteration, TaskStatus } from '../src/types';

function iteration(number: number, status: TaskStatus): Iteration {
  return {
    id: `it-${number}`,
    issue_id: 'issue-1',
    number,
    context: '',
    review_context: '',
    is_review_need: false,
    steps: ['resolve'],
    status,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('extractIssueKeyFromUrl', () => {
  it('returns the last path segment', () => {
    expect(
      extractIssueKeyFromUrl('https://jira.example.com/browse/KLA-5672'),
    ).toBe('KLA-5672');
  });

  it('ignores a trailing slash', () => {
    expect(
      extractIssueKeyFromUrl('https://jira.example.com/browse/KLA-5672/'),
    ).toBe('KLA-5672');
  });

  it('returns null when there is no path segment', () => {
    expect(extractIssueKeyFromUrl('https://jira.example.com')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractIssueKeyFromUrl('')).toBeNull();
  });

  it('returns null for a blank string', () => {
    expect(extractIssueKeyFromUrl('   ')).toBeNull();
  });
});

describe('extractRepoNameFromUrl', () => {
  it('parses an scp-like SSH url', () => {
    expect(extractRepoNameFromUrl('git@gitlab.example.com:files-web.git')).toBe(
      'files-web',
    );
  });

  it('parses an https url with .git suffix', () => {
    expect(extractRepoNameFromUrl('https://github.com/org/repo.git')).toBe(
      'repo',
    );
  });

  it('parses an https url without .git suffix', () => {
    expect(extractRepoNameFromUrl('https://github.com/org/repo')).toBe('repo');
  });

  it('returns the last segment of a nested SSH path', () => {
    expect(
      extractRepoNameFromUrl('git@gitlab.example.com:group/sub/repo.git'),
    ).toBe('repo');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date(2026, 0, 5, 14, 7, 0);

  it('says "только что" under a minute', () => {
    const iso = new Date(now.getTime() - 59 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe('только что');
  });

  it('counts minutes', () => {
    const iso = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe('5 мин назад');
  });

  it('floors partial minutes to at least one', () => {
    const iso = new Date(now.getTime() - 61 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe('1 мин назад');
  });

  it('counts hours', () => {
    const iso = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe('3 ч назад');
  });

  it('counts days', () => {
    const iso = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe('2 дн назад');
  });

  it('floors partial days to at least one', () => {
    const iso = new Date(
      now.getTime() - (25 * 60 * 60 * 1000),
    ).toISOString();
    expect(formatRelativeTime(iso, now)).toBe('1 дн назад');
  });
});

describe('formatDateTime', () => {
  it('formats in local ru-RU style', () => {
    const iso = new Date(2026, 0, 5, 14, 7).toISOString();
    expect(formatDateTime(iso)).toBe('05.01.2026, 14:07');
  });

  it('zero-pads single-digit day and month', () => {
    const iso = new Date(2026, 8, 9, 3, 4).toISOString();
    expect(formatDateTime(iso)).toBe('09.09.2026, 03:04');
  });
});

describe('statusOfIssue', () => {
  it('returns null for no iterations', () => {
    expect(statusOfIssue([])).toBeNull();
  });

  it('returns the status of the highest number', () => {
    expect(
      statusOfIssue([
        iteration(1, 'completed'),
        iteration(3, 'running'),
        iteration(2, 'failed'),
      ]),
    ).toBe('running');
  });

  it('handles an unsorted single iteration', () => {
    expect(statusOfIssue([iteration(7, 'cancelled')])).toBe('cancelled');
  });
});

describe('canStartIteration', () => {
  it('allows starting when there are no iterations', () => {
    expect(canStartIteration([])).toBe(true);
  });

  it('allows starting after a completed highest iteration', () => {
    expect(
      canStartIteration([iteration(1, 'failed'), iteration(2, 'completed')]),
    ).toBe(true);
  });

  it('allows starting after a failed highest iteration', () => {
    expect(canStartIteration([iteration(2, 'failed')])).toBe(true);
  });

  it('blocks while the highest iteration is running', () => {
    expect(
      canStartIteration([iteration(1, 'completed'), iteration(2, 'running')]),
    ).toBe(false);
  });

  it('blocks while the highest iteration is pending', () => {
    expect(canStartIteration([iteration(1, 'pending')])).toBe(false);
  });

  it('allows starting after a cancelled highest iteration', () => {
    expect(canStartIteration([iteration(1, 'cancelled')])).toBe(true);
  });
});