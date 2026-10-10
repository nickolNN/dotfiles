import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { Issue, ModelDescriptor } from '@issue-resolver/shared';
import NewIssue from './NewIssue';

const createdIssue: Issue = {
  id: 'issue-1',
  title: 'Fix login bug',
  jira_issue_url: null,
  repositories: [],
  pipeline_steps: ['resolve'],
  status: 'pending',
  created_at: '2026-10-09T00:00:00.000Z',
  updated_at: '2026-10-09T00:00:00.000Z',
};

const models: ModelDescriptor[] = [
  { id: 'm1', name: 'Model One' },
  { id: 'm2' },
];

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

/** Различает GET /models и POST /issues. Возвращает записи вызовов для assert'ов. */
function stubFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      return Promise.resolve(jsonResponse(models));
    }
    if (init?.method === 'POST') {
      return Promise.resolve(jsonResponse(createdIssue, { status: 201 }));
    }
    return Promise.resolve(jsonResponse(createdIssue));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function fillRequired() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Добавить репозиторий' }),
  );
  fireEvent.change(screen.getByLabelText('Заголовок'), {
    target: { value: 'Fix login bug' },
  });
  fireEvent.change(screen.getByLabelText('Адрес'), {
    target: { value: 'git@github.com:org/repo.git' },
  });
  fireEvent.change(screen.getByLabelText('Базовая ветка'), {
    target: { value: 'main' },
  });
}

function postBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const postCall = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
  );
  expect(postCall).toBeTruthy();
  const [, init] = postCall as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NewIssue — селектор модели (per-step)', () => {
  it('грузит модели и рендерит селектор только для выбранных шагов (name ?? id)', async () => {
    stubFetch();

    render(<NewIssue />);

    // Всегда отмечен только resolve → один селектор с одним набором опций.
    expect(await screen.findAllByRole('option', { name: 'Model One' })).toHaveLength(1);
    expect(screen.getAllByRole('option', { name: 'm2' })).toHaveLength(1);
    expect(screen.getAllByRole('option', { name: 'По умолчанию' })).toHaveLength(1);
    expect(screen.getByLabelText('Модель для шага Resolve')).toBeInTheDocument();

    // Отмечаем ещё два шага — появляются их селекторы.
    fireEvent.click(screen.getByLabelText('Refine'));
    fireEvent.click(screen.getByLabelText('Review'));
    expect(await screen.findAllByRole('option', { name: 'Model One' })).toHaveLength(3);
  });

  it('выбор модели для resolve попадает в POST body.step_models.resolve', async () => {
    const fetchMock = stubFetch();

    render(<NewIssue />);
    await screen.findAllByRole('option', { name: 'Model One' });

    fireEvent.change(screen.getByLabelText('Модель для шага Resolve'), {
      target: { value: 'm1' },
    });
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = postBody(fetchMock);
      expect(body.step_models).toEqual({ resolve: 'm1' });
      expect(body.model).toBeUndefined();
    });
  });

  it('без выбора моделей в POST body нет ни step_models, ни model', async () => {
    const fetchMock = stubFetch();

    render(<NewIssue />);
    await screen.findAllByRole('option', { name: 'Model One' });

    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = postBody(fetchMock);
      expect(body.step_models).toBeUndefined();
      expect(body.model).toBeUndefined();
    });
  });

  it('селектор шага рендерится только при отмеченном шаге; снятый шаг не уходит в step_models', async () => {
    const fetchMock = stubFetch();

    render(<NewIssue />);
    await screen.findAllByRole('option', { name: 'Model One' });

    // resolve отмечен всегда → селектор виден; refine пока снят → селектора нет.
    expect(screen.getByLabelText('Модель для шага Resolve')).toBeEnabled();
    expect(screen.queryByLabelText('Модель для шага Refine')).toBeNull();

    fireEvent.click(screen.getByLabelText('Refine'));
    const refineModel = screen.getByLabelText('Модель для шага Refine');
    expect(refineModel).toBeEnabled();
    fireEvent.change(refineModel, { target: { value: 'm2' } });

    // Снимаем шаг — его модель отфильтровывается из payload, селектор скрыт.
    fireEvent.click(screen.getByLabelText('Refine'));
    expect(screen.queryByLabelText('Модель для шага Refine')).toBeNull();

    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

    await waitFor(() => {
      const body = postBody(fetchMock);
      expect(body.step_models).toBeUndefined();
    });
  });
});