import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type {
  Issue,
  Iteration,
  SessionStats,
  StepRunWithLog,
} from '@issue-resolver/shared';
import TaskDetail, {
  formatStepDuration,
  shortPath,
  stepChangedFiles,
} from './TaskDetail';
import type { SessionEvent } from '../api/session-events';

function makeIssue(): Issue {
  return {
    id: 'issue-1',
    title: 'Fix login bug',
    jira_issue_url: null,
    repositories: [],
    pipeline_steps: ['resolve'],
    status: 'running',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
  };
}

function makeIteration(): Iteration {
  return {
    id: 'iter-1',
    issue_id: 'issue-1',
    number: 1,
    context: 'first try',
    review_context: '',
    is_review_need: false,
    steps: ['resolve'],
    status: 'running',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
  };
}

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    model: 'Claude Sonnet 4',
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 3,
    toolResults: 3,
    totalMessages: 6,
    tokens: {
      input: 1200,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1700,
    },
    cost: null,
    contextUsage: null,
    ...overrides,
  };
}

function makeStepRun(
  overrides: Partial<StepRunWithLog> = {},
): StepRunWithLog {
  return {
    id: 'run-1',
    iteration_id: 'iter-1',
    step: 'resolve',
    attempt: 1,
    status: 'success',
    context: '',
    feedback: null,
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    stdout: '',
    stderr: '',
    events: [],
    stats: null,
    report: null,
    screenshots_dir: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function stubFetch(stepRuns: StepRunWithLog[]) {
  const issue = makeIssue();
  const iteration = makeIteration();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/step-runs')) {
      return Promise.resolve(jsonResponse(stepRuns));
    }
    if (url.endsWith('/iterations')) {
      return Promise.resolve(jsonResponse([iteration]));
    }
    return Promise.resolve(jsonResponse(issue));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('formatStepDuration', () => {
  it('секунды / минуты / часы, null и отрицательное → пусто', () => {
    expect(formatStepDuration(45_000)).toBe('45с');
    expect(formatStepDuration(192_000)).toBe('3м 12с');
    expect(formatStepDuration(3_720_000)).toBe('1ч 2м');
    expect(formatStepDuration(null)).toBe('');
    expect(formatStepDuration(-5)).toBe('');
  });
});

describe('shortPath', () => {
  const uuid = 'f39c613b-e75f-444e-b817-c1ae0a58b161';

  it('отбрасывает workspace-uuid вместе с абсолютным префиксом', () => {
    expect(
      shortPath(`/home/agent/.issue-resolver/workspaces/${uuid}/report.html`),
    ).toBe('report.html');
    expect(
      shortPath(`/home/agent/.issue-resolver/workspaces/${uuid}/src/app.ts`),
    ).toBe('src/app.ts');
    expect(shortPath(`${uuid}/report.html`)).toBe('report.html');
  });

  it('глубже двух сегментов после uuid → basename', () => {
    expect(
      shortPath(`/workspaces/${uuid}/src/components/deep/Foo.tsx`),
    ).toBe('Foo.tsx');
  });

  it('без uuid: абсолютный — последние два сегмента, относительный — как есть', () => {
    expect(shortPath('/workspace/shots/run-1')).toBe('shots/run-1');
    expect(shortPath('src/a.ts')).toBe('src/a.ts');
  });
});

describe('stepChangedFiles', () => {
  it('write/edit включены, read исключён, дубликаты и harness-маркер убраны', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', toolCallId: '1', toolName: 'write', args: { path: 'src/a.ts' } },
      { type: 'tool_use', toolCallId: '2', toolName: 'edit', args: { path: 'src/b.tsx' } },
      { type: 'tool_use', toolCallId: '3', toolName: 'read', args: { path: 'src/c.ts' } },
      { type: 'tool_use', toolCallId: '4', toolName: 'edit', args: { path: 'src/a.ts' } },
      {
        type: 'tool_use',
        toolCallId: '5',
        toolName: 'write',
        args: { path: '.issue-step-result.json' },
      },
    ];

    expect(stepChangedFiles(events)).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('нет изменяющих tool_use → пустой список', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', toolCallId: '1', toolName: 'read', args: { path: 'a.ts' } },
      { type: 'text', text: 'готово' },
    ];
    expect(stepChangedFiles(events)).toEqual([]);
  });
});

describe('TaskDetail — статистика карточки шага', () => {
  it('токены/модель/вызовы в формате ↑ / ↓ / кеш, без cost', async () => {
    stubFetch([
      makeStepRun({ stats: makeStats(), report: JSON.stringify({ status: 'pass', summary: 'ok' }) }),
    ]);
    render(<TaskDetail issueId="issue-1" />);

    const tokens = await screen.findByTestId('step-tokens');
    expect(tokens).toHaveTextContent('Claude Sonnet 4');
    expect(within(tokens).getByTestId('session-token-in')).toHaveTextContent(
      '1.2k',
    );
    expect(within(tokens).getByTestId('session-token-out')).toHaveTextContent(
      '500',
    );
    expect(tokens.querySelectorAll('svg')).toHaveLength(2);
    expect(tokens).toHaveTextContent('кеш 0');
    expect(tokens).toHaveTextContent('3 вызовов');
    expect(tokens).not.toHaveTextContent('$');
  });

  it('contextUsage есть → CTX показан из run.stats', async () => {
    stubFetch([
      makeStepRun({
        stats: makeStats({
          contextUsage: {
            tokens: 42_000,
            contextWindow: 200_000,
            percent: 21,
          },
        }),
      }),
    ]);
    render(<TaskDetail issueId="issue-1" />);

    const tokens = await screen.findByTestId('step-tokens');
    expect(tokens).toHaveTextContent('CTX 21%');
  });

  it('running-шаг: live stats-событие показывает строку без run.stats', async () => {
    stubFetch([
      makeStepRun({
        status: 'running',
        stats: null,
        events: [
          { type: 'stats', stats: makeStats({ model: 'Claude Sonnet 4' }) },
        ],
      }),
    ]);
    render(<TaskDetail issueId="issue-1" />);

    const tokens = await screen.findByTestId('step-tokens');
    expect(tokens).toHaveTextContent('Claude Sonnet 4');
    expect(within(tokens).getByTestId('session-token-in')).toHaveTextContent(
      '1.2k',
    );
    expect(within(tokens).getByTestId('session-token-out')).toHaveTextContent(
      '500',
    );
    expect(tokens).toHaveTextContent('кеш 0');
    expect(tokens).toHaveTextContent('3 вызовов');
  });

  it('running-шаг: live usage-событие даёт токены, вызовы деградируют до 0', async () => {
    stubFetch([
      makeStepRun({
        status: 'running',
        stats: null,
        events: [
          {
            type: 'usage',
            usage: {
              input: 1500,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 1500,
            },
            cost: null,
          },
        ],
      }),
    ]);
    render(<TaskDetail issueId="issue-1" />);

    const tokens = await screen.findByTestId('step-tokens');
    expect(within(tokens).getByTestId('session-token-in')).toHaveTextContent(
      '1.5k',
    );
    expect(within(tokens).getByTestId('session-token-out')).toHaveTextContent(
      '0',
    );
    expect(tokens).toHaveTextContent('0 вызовов');
  });

  it('чёрный блок шага не содержит session-stats, статистика — в футере', async () => {
    stubFetch([
      makeStepRun({ status: 'running', stats: makeStats(), report: null }),
    ]);
    render(<TaskDetail issueId="issue-1" />);

    const session = await screen.findByTestId('step-session');
    expect(within(session).queryByTestId('session-stats')).toBeNull();
    const tokens = await screen.findByTestId('step-tokens');
    expect(within(tokens).getByTestId('session-token-in')).toHaveTextContent(
      '1.2k',
    );
  });

  it('статус отчёта — uppercase PASS', async () => {
    stubFetch([
      makeStepRun({ report: JSON.stringify({ status: 'pass', summary: 'всё ок' }) }),
    ]);
    render(<TaskDetail issueId="issue-1" />);

    const summary = await screen.findByTestId('step-summary');
    expect(summary).toHaveTextContent('PASS');
    expect(summary).toHaveTextContent('всё ок');
  });

  it('терминальная длительность из updated_at - created_at', async () => {
    stubFetch([
      makeStepRun({
        status: 'success',
        created_at: '2026-10-09T00:00:00.000Z',
        updated_at: '2026-10-09T00:00:45.000Z',
      }),
    ]);
    render(<TaskDetail issueId="issue-1" />);

    expect(await screen.findByTestId('step-duration')).toHaveTextContent('45с');
  });

  it('aborted-шаг тоже показывает длительность', async () => {
    stubFetch([
      makeStepRun({
        status: 'aborted',
        created_at: '2026-10-09T00:00:00.000Z',
        updated_at: '2026-10-09T00:03:12.000Z',
      }),
    ]);
    render(<TaskDetail issueId="issue-1" />);

    expect(await screen.findByTestId('step-duration')).toHaveTextContent(
      '3м 12с',
    );
  });

  it('файлы: write/edit перечислены, read не попадает', async () => {
    stubFetch([
      makeStepRun({
        events: [
          { type: 'tool_use', toolCallId: '1', toolName: 'write', args: { path: 'src/a.ts' } },
          { type: 'tool_use', toolCallId: '2', toolName: 'edit', args: { path: 'src/b.tsx' } },
          { type: 'tool_use', toolCallId: '3', toolName: 'read', args: { path: 'src/c.ts' } },
        ],
      }),
    ]);
    render(<TaskDetail issueId="issue-1" />);

    const files = await screen.findByTestId('step-files');
    expect(files).toHaveTextContent('Файлы: src/a.ts, src/b.tsx');
    expect(files).not.toHaveTextContent('src/c.ts');
  });

  it('workspace-uuid в пути срезается до repo-relative остатка', async () => {
    const uuid = 'f39c613b-e75f-444e-b817-c1ae0a58b161';
    stubFetch([
      makeStepRun({
        events: [
          {
            type: 'tool_use',
            toolCallId: '1',
            toolName: 'write',
            args: {
              path: `/home/agent/.issue-resolver/workspaces/${uuid}/report.html`,
            },
          },
          {
            type: 'tool_use',
            toolCallId: '2',
            toolName: 'edit',
            args: {
              path: `/home/agent/.issue-resolver/workspaces/${uuid}/src/app.ts`,
            },
          },
        ],
      }),
    ]);
    render(<TaskDetail issueId="issue-1" />);

    const files = await screen.findByTestId('step-files');
    expect(files).toHaveTextContent('Файлы: report.html, src/app.ts');
    expect(files).not.toHaveTextContent(uuid);
  });

  it('без изменений файлов → «Файлы не изменялись»', async () => {
    stubFetch([makeStepRun({ events: [] })]);
    render(<TaskDetail issueId="issue-1" />);

    expect(await screen.findByTestId('step-files')).toHaveTextContent(
      'Файлы не изменялись',
    );
  });

  it('артефакты отчёта: сценарии/findings и screenshots_dir', async () => {
    stubFetch([
      makeStepRun({
        report: JSON.stringify({
          status: 'pass',
          summary: 'ok',
          scenarios: [
            { name: 's1', status: 'pass' },
            { name: 's2', status: 'pass' },
          ],
          findings: [{ severity: 'minor', description: 'f1' }],
        }),
        screenshots_dir: '/workspace/shots/run-1',
      }),
    ]);
    render(<TaskDetail issueId="issue-1" />);

    expect(await screen.findByTestId('step-artifacts')).toHaveTextContent(
      '2 сценариев · 1 findings',
    );
    expect(screen.getByTestId('step-screenshots')).toHaveTextContent(
      'shots/run-1',
    );
  });
});