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
import type { RoomAgent, SessionStats } from '@issue-resolver/shared';
import type { SessionEvent } from '../api/session-events';
import RoomAgentTabs from './RoomAgentTabs';

function makeAgent(overrides: Partial<RoomAgent> = {}): RoomAgent {
  return {
    id: 'run-1/worker/0',
    role: 'worker',
    index: 1,
    label: 'Исполнитель 1',
    status: 'running',
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
  status: 'finished',
});
const COORDINATOR = makeAgent({
  id: 'run-1',
  role: 'coordinator',
  index: null,
  label: 'Координатор',
  status: 'running',
});
const AGENTS: RoomAgent[] = [WORKER_1, WORKER_2, COORDINATOR];

/** Полный SessionStats с переопределяемыми полями (tokens/cost). */
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

/** Фейк EventSource: запоминает URL/закрытие и отдаёт onmessage вручную. */
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

/** step_event-эмит как его кладёт бэкенд в data (`{stepRunId, agentId, event}`). */
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

function stubFetch(agents: RoomAgent[]): void {
  stubFetchDynamic(() => agents);
}

/** Динамический список агентов: тест меняет ответ между запросами. */
function stubFetchDynamic(getAgents: () => RoomAgent[]): { agents: number } {
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

describe('RoomAgentTabs — вкладки агентов комнаты', () => {
  it('staged-режим: вкладки группируются по этапу, финальный координатор — последним', async () => {
    const staged: RoomAgent[] = [
      makeAgent({
        id: 'stage-2/worker/0',
        index: 1,
        label: 'Этап 2 · Исполнитель 1',
        stage: 2,
      } as Partial<RoomAgent>),
      makeAgent({
        id: 'stage-1/coordinator',
        role: 'coordinator',
        index: null,
        label: 'Этап 1 · Координатор',
        stage: 1,
      } as Partial<RoomAgent>),
      makeAgent({
        id: 'stage-1/worker/1',
        index: 2,
        label: 'Этап 1 · Исполнитель 2',
        stage: 1,
      } as Partial<RoomAgent>),
      makeAgent({
        id: 'stage-1/worker/0',
        index: 1,
        label: 'Этап 1 · Исполнитель 1',
        stage: 1,
      } as Partial<RoomAgent>),
      makeAgent({
        id: 'final',
        role: 'coordinator',
        index: null,
        label: 'Координатор',
        stage: null,
      } as Partial<RoomAgent>),
    ];
    stubFetch(staged);

    render(<RoomAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('room-agents');

    const tabs = screen.getAllByTestId('room-agent-tab');
    // Порядок: этап 1 (исполнители 1,2, затем координатор этапа) → этап 2 →
    // финальный координатор (stage=null).
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
    // Координатор этапа — не финальный, «(lead)» ему не добавляем.
    expect(tabs[2]).not.toHaveTextContent('(lead)');
    expect(tabs[3]).toHaveTextContent('Этап 2 · Исполнитель 1');
    expect(tabs[4]).toHaveTextContent('Координатор (lead)');
  });

  it('рендерит исполнителей по порядку и координатора с пометкой (lead)', async () => {
    stubFetch(AGENTS);

    render(<RoomAgentTabs iterationId="iter-1" />);

    const container = await screen.findByTestId('room-agents');
    expect(container).toBeInTheDocument();

    const tabs = screen.getAllByTestId('room-agent-tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveTextContent('Исполнитель 1');
    expect(tabs[1]).toHaveTextContent('Исполнитель 2');
    expect(tabs[2]).toHaveTextContent('Координатор (lead)');

    // Статус каждого агента виден и продублирован в data-status.
    expect(tabs[0]).toHaveAttribute('data-status', 'running');
    expect(tabs[1]).toHaveAttribute('data-status', 'finished');
    expect(tabs[2]).toHaveAttribute('data-role', 'coordinator');
  });

  it('по умолчанию выбирает первого running-агента и подписывается на его поток', async () => {
    stubFetch(AGENTS);

    render(<RoomAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('room-agents');

    const tabs = screen.getAllByTestId('room-agent-tab');
    expect(tabs[0]).toHaveAttribute('data-selected', 'true');
    expect(tabs[1]).toHaveAttribute('data-selected', 'false');

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toContain(
      '/iterations/iter-1/agents/stream?agentId=run-1%2Fworker%2F0',
    );
  });

  it('live-событие выбранного агента попадает в его SessionView', async () => {
    stubFetch(AGENTS);

    render(<RoomAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('room-agents');

    act(() => {
      FakeEventSource.instances[0].emit(
        stepEvent('run-1/worker/0', { type: 'text', text: 'привет от исполнителя' }),
      );
    });

    expect(await screen.findByText('привет от исполнителя')).toBeInTheDocument();
  });

  it('переключение вкладки меняет поток и показывает сессию другого агента', async () => {
    stubFetch(AGENTS);

    render(<RoomAgentTabs iterationId="iter-1" />);
    const tabs = await screen.findAllByTestId('room-agent-tab');

    act(() => {
      FakeEventSource.instances[0].emit(
        stepEvent('run-1/worker/0', { type: 'text', text: 'сессия исполнителя 1' }),
      );
    });
    expect(await screen.findByText('сессия исполнителя 1')).toBeInTheDocument();

    fireEvent.click(tabs[1]); // Исполнитель 2

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[0].close).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances[1].url).toContain(
      'agentId=run-1%2Fworker%2F1',
    );

    const selectedTabs = screen.getAllByTestId('room-agent-tab');
    expect(selectedTabs[1]).toHaveAttribute('data-selected', 'true');
    expect(
      screen.getByTestId('room-agent-session'),
    ).toHaveAttribute('data-agent-id', 'run-1/worker/1');

    act(() => {
      FakeEventSource.instances[1].emit(
        stepEvent('run-1/worker/1', { type: 'text', text: 'сессия исполнителя 2' }),
      );
    });
    expect(await screen.findByText('сессия исполнителя 2')).toBeInTheDocument();
    expect(screen.queryByText('сессия исполнителя 1')).toBeNull();
  });

  it('персистентные eventsByAgent показываются для выбранного агента', async () => {
    stubFetch(AGENTS);

    render(
      <RoomAgentTabs
        iterationId="iter-1"
        eventsByAgent={{
          'run-1/worker/1': [{ type: 'text', text: 'из персиста' }],
        }}
      />,
    );
    const tabs = await screen.findAllByTestId('room-agent-tab');

    fireEvent.click(tabs[1]);

    expect(await screen.findByText('из персиста')).toBeInTheDocument();
  });

  it('пустой список агентов показывает заглушку и не открывает SSE', async () => {
    stubFetch([]);

    render(
      <RoomAgentTabs iterationId="iter-1" maxEmptyRetries={0} />,
    );

    expect(await screen.findByTestId('room-agents-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('room-agents')).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('размонтирование закрывает EventSource выбранного агента', async () => {
    stubFetch(AGENTS);

    const { unmount } = render(<RoomAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('room-agents');
    // Эффект подписки разворачивается после коммита — дожидаемся EventSource.
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    unmount();

    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('фоновое обновление по refreshKey не мигает загрузкой и обновляет статус', async () => {
    let agents = AGENTS;
    stubFetchDynamic(() => agents);

    const { rerender } = render(<RoomAgentTabs iterationId="iter-1" />);
    const tabs = await screen.findAllByTestId('room-agent-tab');
    expect(tabs[0]).toHaveAttribute('data-status', 'running');

    // Исполнитель 1 завершился — родитель бампает refreshKey, статусы перечитываются.
    agents = [
      makeAgent({ ...WORKER_1, status: 'finished' }),
      WORKER_2,
      COORDINATOR,
    ];
    rerender(<RoomAgentTabs iterationId="iter-1" refreshKey={1} />);

    // Вкладки не подменяются заглушкой загрузки на время фонового fetch.
    expect(screen.queryByTestId('room-agents-loading')).toBeNull();
    expect(screen.getByTestId('room-agents')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getAllByTestId('room-agent-tab')[0]).toHaveAttribute(
        'data-status',
        'finished',
      ),
    );
  });

  it('пока агент running, список агентов периодически перечитывается', async () => {
    let agents = AGENTS;
    const calls = stubFetchDynamic(() => agents);

    render(<RoomAgentTabs iterationId="iter-1" statusPollMs={15} />);
    await screen.findAllByTestId('room-agent-tab');
    const initial = calls.agents;

    agents = [
      makeAgent({ ...WORKER_1, status: 'finished' }),
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

    render(<RoomAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('room-agents');

    // Живой футер включён и берёт числа из stats выбранного агента.
    expect(screen.getByTestId('session-stats')).toBeInTheDocument();
    expect(screen.getByTestId('session-token-in')).toHaveTextContent('1k');
    expect(screen.getByTestId('session-token-out')).toHaveTextContent('500');
  });

  it('итог room-step-summary суммирует токены и cost по всем агентам', async () => {
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
        status: 'finished',
        stats: makeStats({
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 2000 },
          cost: 0.02,
        }),
      }),
    ]);

    render(<RoomAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('room-agents');

    const summary = screen.getByTestId('room-step-summary');
    expect(summary).toHaveTextContent('Всего:');
    expect(summary).toHaveTextContent('1k');
    expect(summary).toHaveTextContent('$0.03');
  });

  it('null startedAt/stats не роняет компонент и даёт нулевой итог', async () => {
    stubFetch([makeAgent()]); // startedAt: null, stats: null

    render(<RoomAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('room-agents');

    const summary = screen.getByTestId('room-step-summary');
    expect(summary).toHaveTextContent('Всего:');
    expect(summary).toHaveTextContent('$0');
    // Без старта время агента не показываем.
    expect(screen.queryByTestId('room-agent-duration')).toBeNull();
  });

  it('staged-режим: сводка по этапам агрегирует токены/cost/модели/CTX', async () => {
    stubFetch([
      makeAgent({
        id: 'stage-1/worker/0',
        index: 1,
        label: 'Этап 1 · Исполнитель 1',
        stage: 1,
        stageName: 'Сбор',
        status: 'finished',
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
      } as Partial<RoomAgent>),
      makeAgent({
        id: 'stage-1/coordinator',
        role: 'coordinator',
        index: null,
        label: 'Этап 1 · Координатор',
        stage: 1,
        stageName: 'Сбор',
        status: 'finished',
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
      } as Partial<RoomAgent>),
      makeAgent({
        id: 'stage-2/worker/0',
        index: 1,
        label: 'Этап 2 · Исполнитель 1',
        stage: 2,
        stageName: 'Реализация',
        status: 'running',
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
      } as Partial<RoomAgent>),
      makeAgent({
        id: 'final',
        role: 'coordinator',
        index: null,
        label: 'Координатор',
        stage: null,
      } as Partial<RoomAgent>),
    ]);

    render(<RoomAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('room-agents');

    const groups = screen.getAllByTestId('room-stage-group');
    expect(groups).toHaveLength(2);

    // Этап 1: исполнитель + координатор → токены/cost суммируются, модели
    // различаются без дублей, CTX — максимум по этапу.
    expect(groups[0]).toHaveAttribute('data-stage', '1');
    expect(groups[0]).toHaveAttribute('data-stage-name', 'Сбор');
    expect(within(groups[0]).getByTestId('room-stage-name')).toHaveTextContent(
      'Сбор',
    );
    expect(within(groups[0]).getByTestId('room-stage-tokens')).toHaveTextContent(
      '3k',
    );
    expect(within(groups[0]).getByTestId('room-stage-cost')).toHaveTextContent(
      '$0.03',
    );
    expect(
      within(groups[0]).getByTestId('room-stage-models'),
    ).toHaveTextContent('Claude Sonnet 4, Claude Opus 4');
    expect(
      within(groups[0]).getByTestId('room-stage-context'),
    ).toHaveTextContent('CTX 30%');
    // Wall-time этапа посчитан (а не «—»): агенты завершились.
    expect(
      within(groups[0]).getByTestId('room-stage-duration').textContent,
    ).not.toBe('—');

    // Этап 2: один исполнитель без contextUsage → CTX-сегмента нет.
    expect(groups[1]).toHaveAttribute('data-stage', '2');
    expect(groups[1]).toHaveAttribute('data-stage-name', 'Реализация');
    expect(within(groups[1]).getByTestId('room-stage-tokens')).toHaveTextContent(
      '500',
    );
    expect(within(groups[1]).getByTestId('room-stage-cost')).toHaveTextContent(
      '$0.005',
    );
    expect(within(groups[1]).queryByTestId('room-stage-context')).toBeNull();

    // Финальный координатор (stage === null) в сводку не входит — групп ровно 2
    // и все вкладки (включая финального lead) остаются на месте.
    expect(screen.getAllByTestId('room-agent-tab')).toHaveLength(4);
  });

  it('staged-сводка переживает null stats и отсутствие моделей/CTX', async () => {
    stubFetch([
      makeAgent({
        id: 'stage-3/worker/0',
        index: 1,
        label: 'Этап 3 · Исполнитель 1',
        stage: 3,
        stageName: 'Проверка',
        status: 'finished',
        stats: null,
      } as Partial<RoomAgent>),
    ]);

    render(<RoomAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('room-agents');

    const group = screen.getByTestId('room-stage-group');
    expect(group).toHaveTextContent('Проверка');
    expect(group).toHaveTextContent('$0');
    expect(within(group).getByTestId('room-stage-models')).toHaveTextContent('—');
    expect(within(group).queryByTestId('room-stage-context')).toBeNull();
    // Без startedAt времени этапа нет.
    expect(within(group).getByTestId('room-stage-duration')).toHaveTextContent(
      '—',
    );
  });

  it('обычная комната без stage не показывает сводку по этапам', async () => {
    stubFetch(AGENTS);

    render(<RoomAgentTabs iterationId="iter-1" />);
    await screen.findByTestId('room-agents');

    expect(screen.queryByTestId('room-stage-summary')).toBeNull();
  });
});