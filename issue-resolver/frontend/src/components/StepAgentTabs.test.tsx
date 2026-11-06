import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { StepAgent, SessionStats } from '@issue-resolver/shared';
import type { SessionEvent } from '../api/session-events';
import StepAgentTabs from './StepAgentTabs';
import { StepAgentStatus } from '@issue-resolver/shared';

function makeAgent(overrides: Partial<StepAgent> = {}): StepAgent {
  return {
    id: 'run-1/worker/0',
    role: 'worker',
    index: 1,
    label: 'Исполнитель 1',
    status: StepAgentStatus.running,
    startedAt: null,
    stats: null,
    ...overrides,
  };
}

const WORKER_1 = makeAgent();
const WORKER_2 = makeAgent({
  id: 'run-1/worker/1',
  index: 2,
  label: 'Исполнитель 2',
  status: StepAgentStatus.finished,
});
const COORDINATOR = makeAgent({
  id: 'run-1',
  role: 'coordinator',
  index: null,
  label: 'Координатор',
  status: StepAgentStatus.running,
});
const AGENTS: StepAgent[] = [WORKER_1, WORKER_2, COORDINATOR];

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 2,
    toolResults: 2,
    totalMessages: 2,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
    cost: 0.01,
    contextUsage: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

function stepEvent(agentId: string, event: SessionEvent): unknown {
  return {
    type: 'step_event',
    issueId: 'issue-1',
    iterationId: 'iter-1',
    stepRunId: agentId,
    agentId,
    data: JSON.stringify({ stepRunId: agentId, agentId, event }),
    ts: '2026-10-10T00:00:00.000Z',
  };
}

function stubFetch(agents: StepAgent[]): void {
  stubFetchDynamic(() => agents);
}

function stubFetchDynamic(getAgents: () => StepAgent[]): { agents: number } {
  const calls = { agents: 0 };
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/iterations/iter-1/agents')) {
      calls.agents += 1;
      return Promise.resolve(jsonResponse(getAgents()));
    }
    return Promise.resolve(jsonResponse([]));
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('StepAgentTabs — вкладки агентов комнаты', () => {
  it('staged-режим: вкладки группируются по этапу, финальный координатор — последним', async () => {
    const staged: StepAgent[] = [
      makeAgent({
        id: 'stage-2/worker/0',
        index: 1,
        label: 'Этап 2 · Исполнитель 1',
        stage: 2,
      } as Partial<StepAgent>),
      makeAgent({
        id: 'stage-1/coordinator',
        role: 'coordinator',
        index: null,
        label: 'Этап 1 · Координатор',
        stage: 1,
      } as Partial<StepAgent>),
      makeAgent({
        id: 'stage-1/worker/1',
        index: 2,
        label: 'Этап 1 · Исполнитель 2',
        stage: 1,
      } as Partial<StepAgent>),
      makeAgent({
        id: 'stage-1/worker/0',
        index: 1,
        label: 'Этап 1 · Исполнитель 1',
        stage: 1,
      } as Partial<StepAgent>),
      makeAgent({
        id: 'final',
        role: 'coordinator',
        index: null,
        label: 'Координатор',
        stage: null,
      } as Partial<StepAgent>),
    ];
    stubFetch(staged);

    render(<StepAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('step-agents');

    const tabs = screen.getAllByTestId('step-agent-tab');
    expect(tabs.map((tab) => tab.getAttribute('data-agent-id'))).toEqual([
      'stage-1/worker/0',
      'stage-1/worker/1',
      'stage-1/coordinator',
      'stage-2/worker/0',
      'final',
    ]);
    expect(tabs[0]).toHaveTextContent('Этап 1 · Исполнитель 1');
    expect(tabs[1]).toHaveTextContent('Этап 1 · Исполнитель 2');
    expect(tabs[2]).toHaveTextContent('Этап 1 · Координатор');
    expect(tabs[2]).not.toHaveTextContent('(lead)');
    expect(tabs[3]).toHaveTextContent('Этап 2 · Исполнитель 1');
    expect(tabs[4]).toHaveTextContent('Координатор (lead)');
  });

  it('рендерит исполнителей по порядку и координатора с пометкой (lead)', async () => {
    stubFetch(AGENTS);

    render(<StepAgentTabs iterationId="iter-1" />);

    const container = await screen.findByTestId('step-agents');
    expect(container).toBeInTheDocument();

    const tabs = screen.getAllByTestId('step-agent-tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveTextContent('Исполнитель 1');
    expect(tabs[1]).toHaveTextContent('Исполнитель 2');
    expect(tabs[2]).toHaveTextContent('Координатор (lead)');

    expect(tabs[0]).toHaveAttribute('data-status', 'running');
    expect(tabs[1]).toHaveAttribute('data-status', 'finished');
    expect(tabs[2]).toHaveAttribute('data-role', 'coordinator');
  });

  it('по умолчанию выбирает первого running-агента и подписывается на его поток', async () => {
    stubFetch(AGENTS);

    render(<StepAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('step-agents');

    const tabs = screen.getAllByTestId('step-agent-tab');
    expect(tabs[0]).toHaveAttribute('data-selected', 'true');
    expect(tabs[1]).toHaveAttribute('data-selected', 'false');

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toContain(
      '/iterations/iter-1/agents/stream?agentId=run-1%2Fworker%2F0',
    );
  });

  it('live-событие выбранного агента попадает в его SessionView', async () => {
    stubFetch(AGENTS);

    render(<StepAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('step-agents');
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    const source = FakeEventSource.instances[0];

    act(() => {
      source.emit(
        stepEvent('run-1/worker/0', { type: 'text', text: 'привет от исполнителя' }),
      );
    });

    expect(await screen.findByText('привет от исполнителя')).toBeInTheDocument();
  });

  it('переключение вкладки меняет поток и показывает сессию другого агента', async () => {
    stubFetch(AGENTS);

    render(<StepAgentTabs iterationId="iter-1" />);
    const tabs = await screen.findAllByTestId('step-agent-tab');
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    const firstSource = FakeEventSource.instances[0];

    act(() => {
      firstSource.emit(
        stepEvent('run-1/worker/0', { type: 'text', text: 'сессия исполнителя 1' }),
      );
    });
    expect(await screen.findByText('сессия исполнителя 1')).toBeInTheDocument();

    fireEvent.click(tabs[1]);

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[0].close).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances[1].url).toContain(
      'agentId=run-1%2Fworker%2F1',
    );

    const selectedTabs = screen.getAllByTestId('step-agent-tab');
    expect(selectedTabs[1]).toHaveAttribute('data-selected', 'true');
    expect(
      screen.getByTestId('step-agent-session'),
    ).toHaveAttribute('data-agent-id', 'run-1/worker/1');

    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(1),
    );
    const secondSource = FakeEventSource.instances[1];

    act(() => {
      secondSource.emit(
        stepEvent('run-1/worker/1', { type: 'text', text: 'сессия исполнителя 2' }),
      );
    });
    expect(await screen.findByText('сессия исполнителя 2')).toBeInTheDocument();
    expect(screen.queryByText('сессия исполнителя 1')).toBeNull();
  });

  it('персистентные eventsByAgent показываются для выбранного агента', async () => {
    stubFetch(AGENTS);

    render(
      <StepAgentTabs
        iterationId="iter-1"
        eventsByAgent={{
          'run-1/worker/1': [{ type: 'text', text: 'из персиста' }],
        }}
      />,
    );
    const tabs = await screen.findAllByTestId('step-agent-tab');

    fireEvent.click(tabs[1]);

    expect(await screen.findByText('из персиста')).toBeInTheDocument();
  });

  it('пустой список агентов показывает заглушку и не открывает SSE', async () => {
    stubFetch([]);

    render(
      <StepAgentTabs iterationId="iter-1" maxEmptyRetries={0} />,
    );

    expect(await screen.findByTestId('step-agents-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('step-agents')).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('размонтирование закрывает EventSource выбранного агента', async () => {
    stubFetch(AGENTS);

    const { unmount } = render(<StepAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('step-agents');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    unmount();

    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('фоновое обновление по refreshKey не мигает загрузкой и обновляет статус', async () => {
    let agents = AGENTS;
    stubFetchDynamic(() => agents);

    const { rerender } = render(<StepAgentTabs iterationId="iter-1" />);
    const tabs = await screen.findAllByTestId('step-agent-tab');
    expect(tabs[0]).toHaveAttribute('data-status', 'running');

    agents = [
      makeAgent({ ...WORKER_1, status: StepAgentStatus.finished }),
      WORKER_2,
      COORDINATOR,
    ];
    rerender(<StepAgentTabs iterationId="iter-1" refreshKey={1} />);

    expect(screen.queryByTestId('step-agents-loading')).toBeNull();
    expect(screen.getByTestId('step-agents')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getAllByTestId('step-agent-tab')[0]).toHaveAttribute(
        'data-status',
        'finished',
      ),
    );
  });

  it('пока агент running, список агентов периодически перечитывается', async () => {
    let agents = AGENTS;
    const calls = stubFetchDynamic(() => agents);

    render(<StepAgentTabs iterationId="iter-1" statusPollMs={15} />);
    await screen.findAllByTestId('step-agent-tab');
    const initial = calls.agents;

    agents = [
      makeAgent({ ...WORKER_1, status: StepAgentStatus.finished }),
      WORKER_2,
      COORDINATOR,
    ];

    await waitFor(() => expect(calls.agents).toBeGreaterThan(initial));
  });

  it('футер выбранного агента показывает его живые токены (showFooter)', async () => {
    stubFetch([
      makeAgent({
        startedAt: new Date(Date.now() - 5000).toISOString(),
        stats: makeStats({
          tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
          cost: 0.05,
        }),
      }),
    ]);

    render(<StepAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('step-agents');

    expect(screen.getByTestId('session-stats')).toBeInTheDocument();
    expect(screen.getByTestId('session-token-in')).toHaveTextContent('1k');
    expect(screen.getByTestId('session-token-out')).toHaveTextContent('500');
  });

  it('итог step-agents-summary суммирует токены и cost по всем агентам', async () => {
    stubFetch([
      makeAgent({
        stats: makeStats({
          tokens: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, total: 1000 },
          cost: 0.01,
        }),
      }),
      makeAgent({
        id: 'run-1/worker/1',
        index: 2,
        label: 'Исполнитель 2',
        status: StepAgentStatus.finished,
        stats: makeStats({
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 2000 },
          cost: 0.02,
        }),
      }),
    ]);

    render(<StepAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('step-agents');

    const summary = screen.getByTestId('step-agents-summary');
    expect(summary).toHaveTextContent('Всего:');
    expect(summary).toHaveTextContent('1k');
    expect(summary).toHaveTextContent('$0.03');
  });

  it('итог помечает cost оценкой, пока хоть один агент не отчитался провайдером', async () => {
    stubFetch([
      makeAgent({ stats: makeStats({ cost: 0.01, costFromProvider: true }) }),
      makeAgent({
        id: 'run-1/worker/1',
        index: 2,
        label: 'Исполнитель 2',
        status: StepAgentStatus.finished,
        stats: makeStats({ cost: 0.02 }),
      }),
    ]);

    render(<StepAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('step-agents');

    expect(screen.getByTestId('step-agents-summary')).toHaveTextContent(
      '≈$0.03',
    );
  });

  it('итог без ≈, когда все агенты отчитались провайдером', async () => {
    stubFetch([
      makeAgent({ stats: makeStats({ cost: 0.01, costFromProvider: true }) }),
      makeAgent({
        id: 'run-1/worker/1',
        index: 2,
        label: 'Исполнитель 2',
        status: StepAgentStatus.finished,
        stats: makeStats({ cost: 0.02, costFromProvider: true }),
      }),
    ]);

    render(<StepAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('step-agents');

    const summary = screen.getByTestId('step-agents-summary');
    expect(summary).toHaveTextContent('$0.03');
    expect(summary).not.toHaveTextContent('≈');
  });

  it('null startedAt/stats не роняет компонент и даёт нулевой итог', async () => {
    stubFetch([makeAgent()]);

    render(<StepAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('step-agents');

    const summary = screen.getByTestId('step-agents-summary');
    expect(summary).toHaveTextContent('Всего:');
    expect(summary).toHaveTextContent('$0');
    expect(screen.queryByTestId('step-agent-duration')).toBeNull();
  });

  it('staged-режим: сводка по этапам агрегирует токены/cost/модели/CTX', async () => {
    stubFetch([
      makeAgent({
        id: 'stage-1/worker/0',
        index: 1,
        label: 'Этап 1 · Исполнитель 1',
        stage: 1,
        stageName: 'Сбор',
        status: StepAgentStatus.finished,
        startedAt: new Date(Date.now() - 20_000).toISOString(),
        endedAt: new Date(Date.now() - 5_000).toISOString(),
        stats: makeStats({
          model: 'Claude Sonnet 4',
          tokens: {
            input: 1000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 1000,
          },
          cost: 0.01,
          contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 12 },
        }),
      } as Partial<StepAgent>),
      makeAgent({
        id: 'stage-1/coordinator',
        role: 'coordinator',
        index: null,
        label: 'Этап 1 · Координатор',
        stage: 1,
        stageName: 'Сбор',
        status: StepAgentStatus.finished,
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        endedAt: new Date(Date.now() - 2_000).toISOString(),
        stats: makeStats({
          model: 'Claude Opus 4',
          tokens: {
            input: 2000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 2000,
          },
          cost: 0.02,
          contextUsage: { tokens: 2000, contextWindow: 200_000, percent: 30 },
        }),
      } as Partial<StepAgent>),
      makeAgent({
        id: 'stage-2/worker/0',
        index: 1,
        label: 'Этап 2 · Исполнитель 1',
        stage: 2,
        stageName: 'Реализация',
        status: StepAgentStatus.running,
        stats: makeStats({
          model: 'Claude Sonnet 4',
          tokens: {
            input: 500,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 500,
          },
          cost: 0.005,
          contextUsage: null,
        }),
      } as Partial<StepAgent>),
      makeAgent({
        id: 'final',
        role: 'coordinator',
        index: null,
        label: 'Координатор',
        stage: null,
      } as Partial<StepAgent>),
    ]);

    render(<StepAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('step-agents');

    const groups = screen.getAllByTestId('stage-agents-group');
    expect(groups).toHaveLength(2);

    expect(groups[0]).toHaveAttribute('data-stage', '1');
    expect(groups[0]).toHaveAttribute('data-stage-name', 'Сбор');
    expect(within(groups[0]).getByTestId('stage-agents-name')).toHaveTextContent(
      'Сбор',
    );
    expect(within(groups[0]).getByTestId('stage-agents-tokens')).toHaveTextContent(
      '3k',
    );
    expect(within(groups[0]).getByTestId('stage-agents-cost')).toHaveTextContent(
      '$0.03',
    );
    expect(
      within(groups[0]).getByTestId('stage-agents-models'),
    ).toHaveTextContent('Claude Sonnet 4, Claude Opus 4');
    expect(
      within(groups[0]).getByTestId('stage-agents-context'),
    ).toHaveTextContent('CTX 30%');
    expect(
      within(groups[0]).getByTestId('stage-agents-duration').textContent,
    ).not.toBe('—');

    expect(groups[1]).toHaveAttribute('data-stage', '2');
    expect(groups[1]).toHaveAttribute('data-stage-name', 'Реализация');
    expect(within(groups[1]).getByTestId('stage-agents-tokens')).toHaveTextContent(
      '500',
    );
    expect(within(groups[1]).getByTestId('stage-agents-cost')).toHaveTextContent(
      '$0.005',
    );
    expect(within(groups[1]).queryByTestId('stage-agents-context')).toBeNull();

    expect(screen.getAllByTestId('step-agent-tab')).toHaveLength(4);
  });

  it('staged-сводка переживает null stats и отсутствие моделей/CTX', async () => {
    stubFetch([
      makeAgent({
        id: 'stage-3/worker/0',
        index: 1,
        label: 'Этап 3 · Исполнитель 1',
        stage: 3,
        stageName: 'Проверка',
        status: StepAgentStatus.finished,
        stats: null,
      } as Partial<StepAgent>),
    ]);

    render(<StepAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('step-agents');

    const group = screen.getByTestId('stage-agents-group');
    expect(group).toHaveTextContent('Проверка');
    expect(group).toHaveTextContent('$0');
    expect(within(group).getByTestId('stage-agents-models')).toHaveTextContent('—');
    expect(within(group).queryByTestId('stage-agents-context')).toBeNull();
    expect(within(group).getByTestId('stage-agents-duration')).toHaveTextContent(
      '—',
    );
  });

  it('обычная комната без stage не показывает сводку по этапам', async () => {
    stubFetch(AGENTS);

    render(<StepAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('step-agents');

    expect(screen.queryByTestId('stage-agents-summary')).toBeNull();
  });
});