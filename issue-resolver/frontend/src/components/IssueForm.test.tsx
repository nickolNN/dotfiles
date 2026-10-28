import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import IssueForm from './IssueForm';
import type { IssueFormProps } from './IssueForm';
import type { CreateIssueRequest } from '@issue-resolver/shared';

vi.mock('../api/client', () => ({
  getModels: vi.fn().mockResolvedValue([
    { id: 'gpt-4', name: 'GPT-4', thinkingLevels: ['off', 'low', 'medium', 'high'] },
    { id: 'opus', name: 'Claude Opus', thinkingLevels: ['off', 'medium', 'xhigh'] },
  ]),
  getRepositoryBranches: vi.fn().mockResolvedValue(['main', 'dev', 'feature/x']),
}));

vi.mock('../stores/queries', () => ({
  useSavedRepos: vi.fn(() => ({
    data: [
      { id: 'r1', fullName: 'org/repo-one', url: 'https://git.example.com/org/repo-one.git', cloneUrl: 'https://git.example.com/org/repo-one.git', defaultBranch: 'main', writeAccess: true },
      { id: 'r2', fullName: 'org/repo-two', url: 'https://git.example.com/org/repo-two.git', cloneUrl: 'https://git.example.com/org/repo-two.git', defaultBranch: 'dev', writeAccess: false },
    ],
    isLoading: false,
    error: null,
  })),
  useTags: vi.fn(() => ({
    data: [
      { id: 't1', name: 'frontend', repositories: [{ repository: { id: 'r1', fullName: 'org/repo-one', url: 'https://git.example.com/org/repo-one.git', cloneUrl: 'https://git.example.com/org/repo-one.git', defaultBranch: 'main', writeAccess: true }, bootstrap_enabled: true }] },
    ],
    isLoading: false,
    error: null,
  })),
}));

function renderForm(props: Partial<IssueFormProps> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onBack = vi.fn();
  return {
    ...render(<IssueForm onSubmit={onSubmit} onBack={onBack} {...props} />),
    onSubmit,
    onBack,
  };
}

describe('IssueForm', () => {
  afterEach(cleanup);

  describe('rendering', () => {
    it('renders create mode by default', async () => {
      renderForm();
      await waitFor(() => {
        expect(screen.getByText('Создание задачи')).toBeInTheDocument();
      });
    });

    it('renders edit mode with initialData', async () => {
      renderForm({ initialData: { title: 'Existing' } });
      await waitFor(() => {
        expect(screen.getByText('Редактирование задачи')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Existing')).toBeInTheDocument();
      });
    });

    it('headerless variant omits wrapper and header', async () => {
      render(
        <div data-testid="modal">
          <IssueForm headerless onSubmit={vi.fn().mockResolvedValue(undefined)} />
        </div>,
      );
      await waitFor(() => {
        expect(screen.queryByText('Создание задачи')).not.toBeInTheDocument();
        expect(screen.getByPlaceholderText('Коротко о задаче')).toBeInTheDocument();
      });
    });

    it('renders pipeline step checkboxes', async () => {
      renderForm();
      await waitFor(() => {
        expect(screen.getByText('Исполнение')).toBeInTheDocument();
        expect(screen.getByText('Планирование')).toBeInTheDocument();
        expect(screen.getByText('Код-ревью')).toBeInTheDocument();
      });
    });
  });

  describe('submission', () => {
    it('submits with runImmediately=true on "Запустить"', async () => {
      const { onSubmit } = renderForm();
      await waitFor(() => screen.getByText('Создание задачи'));
      fireEvent.change(screen.getByPlaceholderText('Коротко о задаче'), {
        target: { value: 'Test' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const payload = onSubmit.mock.calls[0][0] as CreateIssueRequest;
      expect(payload.run_immediately).toBe(true);
      expect(payload.title).toBe('Test');
    });

    it('без галочек ни запуск, ни сохранение недоступны, onSubmit не зовётся', async () => {
      const { onSubmit } = renderForm();
      await waitFor(() => screen.getByText('Создание задачи'));

      fireEvent.change(screen.getByPlaceholderText('Коротко о задаче'), {
        target: { value: 'No steps' },
      });
      fireEvent.click(screen.getByRole('checkbox', { name: 'Исполнение' }));

      const run = screen.getByRole('button', { name: 'Запустить' });
      const save = screen.getByRole('button', { name: 'Сохранить' });
      expect(run).toBeDisabled();
      expect(save).toBeDisabled();

      fireEvent.click(run);
      fireEvent.click(save);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('ровно выбранные шаги уходят в pipeline_steps (resolve можно снять)', async () => {
      const { onSubmit } = renderForm();
      await waitFor(() => screen.getByText('Создание задачи'));

      fireEvent.change(screen.getByPlaceholderText('Коротко о задаче'), {
        target: { value: 'Only MR' },
      });
      fireEvent.click(screen.getByRole('checkbox', { name: 'Исполнение' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Merge Request' }));
      fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const payload = onSubmit.mock.calls[0][0] as CreateIssueRequest;
      expect(payload.pipeline_steps).toEqual(['pr']);
    });

    it('submits with runImmediately=false on "Сохранить"', async () => {
      const { onSubmit } = renderForm();
      await waitFor(() => screen.getByText('Создание задачи'));

      fireEvent.change(screen.getByPlaceholderText('Коротко о задаче'), {
        target: { value: 'Draft' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const payload = onSubmit.mock.calls[0][0] as CreateIssueRequest;
      expect(payload.run_immediately).toBe(false);
    });

    it('hides save button when showSaveButton=false', async () => {
      renderForm({ showSaveButton: false, showRunButton: true });
      await waitFor(() => screen.getByText('Создание задачи'));
      expect(screen.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Запустить' })).toBeInTheDocument();
    });

    it('shows error text', async () => {
      renderForm({ error: 'Kaboom', showRunButton: false, showSaveButton: false });
      await waitFor(() => {
        expect(screen.getByText('Kaboom')).toBeInTheDocument();
      });
    });

    it('clears attached files after a successful submit', async () => {
      const { onSubmit } = renderForm();
      await waitFor(() => screen.getByText('Создание задачи'));

      const input = screen.getByTestId('file-picker').querySelector('input[type=file]')!;
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'spec.md', { type: 'text/markdown' })] },
      });
      expect(screen.getByTestId('file-chip')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect((onSubmit.mock.calls[0][1] as File[]).map((file) => file.name)).toEqual([
        'spec.md',
      ]);
      await waitFor(() => expect(screen.queryByTestId('file-chip')).not.toBeInTheDocument());
    });

    it('keeps attached files when submit rejects and shows role=alert', async () => {
      const onReject = vi.fn().mockRejectedValue(new Error('Сервер отказал'));
      render(
        <IssueForm
          onSubmit={onReject}
          submitLabel="Сохранить"
          showRunButton
          showSaveButton={false}
          error="Сервер отказал"
        />,
      );
      await waitFor(() => screen.getByText('Создание задачи'));

      const input = screen.getByTestId('file-picker').querySelector('input[type=file]')!;
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'keep-me.md', { type: 'text/markdown' })] },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
      await waitFor(() => expect(onReject).toHaveBeenCalledTimes(1));

      expect(screen.getByTestId('file-chip')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('Сервер отказал');
    });

    it('swallows a rejecting onSubmit without an unhandled rejection', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);

      const onReject = vi
        .fn()
        .mockRejectedValue(new Error('Не удалось определить title'));
      render(
        <IssueForm
          onSubmit={onReject}
          showRunButton={false}
          showSaveButton
          error="Не удалось определить title"
        />,
      );

      fireEvent.change(screen.getByPlaceholderText('Коротко о задаче'), {
        target: { value: 'Nope' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

      await waitFor(() => expect(onReject).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(
        screen.getByText('Не удалось определить title'),
      ).toBeInTheDocument();

      process.off('unhandledRejection', unhandled);
    });
  });

  describe('devops thinking effort', () => {
    it('renders a thinking selector next to the analyzer model', async () => {
      renderForm();
      await waitFor(() => screen.getByText('Создание задачи'));

      fireEvent.click(screen.getByText('Добавить репозиторий'));
      await waitFor(() => expect(screen.getByText('org/repo-one')).toBeInTheDocument());

      expect(screen.getByTestId('devops-thinking-input')).toBeInTheDocument();
      expect(screen.getByTestId('devops-thinking-input')).toBeDisabled();
    });

    it('sends devops_thinking_level in the payload', async () => {
      const { onSubmit } = renderForm();
      await waitFor(() => screen.getByText('Создание задачи'));

      fireEvent.click(screen.getByText('Добавить репозиторий'));
      await waitFor(() => expect(screen.getByText('org/repo-one')).toBeInTheDocument());

      const modelSelect = screen.getByLabelText(
        "Модель анализатора для DevOps-агента проектов",
      );
      fireEvent.change(modelSelect, { target: { value: 'gpt-4' } });

      const thinking = screen.getByTestId('devops-thinking-input');
      await waitFor(() => expect(thinking).toBeEnabled());
      fireEvent.change(thinking, { target: { value: 'high' } });

      fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      const payload = onSubmit.mock.calls[0][0] as CreateIssueRequest;
      expect(payload.devops_model).toBe('gpt-4');
      expect(payload.devops_thinking_level).toBe('high');
    });

    it('prefills devops model, thinking level and worker count from initialData', async () => {
      renderForm({
        initialData: {
          title: 'Draft',
          repositories: [{ repo_id: 'r1', base_branch: 'main' }],
          devopsModel: 'opus',
          devopsThinkingLevel: 'medium',
          workerCount: 3,
        },
      });
      await waitFor(() => screen.getByText('Редактирование задачи'));

      const modelSelect = screen.getByLabelText(
        "Модель анализатора для DevOps-агента проектов",
      ) as HTMLSelectElement;
      const thinking = screen.getByTestId('devops-thinking-input') as HTMLSelectElement;
      expect(modelSelect.value).toBe('opus');
      expect(thinking.value).toBe('medium');
      expect(screen.getByTestId('worker-count-input')).toHaveValue(3);
    });
  });

  describe('repo management', () => {
    it('adds and removes a repository row', async () => {
      renderForm({ showRunButton: false, showSaveButton: false });
      await waitFor(() => screen.getByText('Создание задачи'));

      fireEvent.click(screen.getByText('Добавить репозиторий'));
      await waitFor(() => expect(screen.getByText('org/repo-one')).toBeInTheDocument());

      fireEvent.click(screen.getAllByText('Удалить')[0]);
      await waitFor(() => {
        expect(screen.queryByText('org/repo-one')).not.toBeInTheDocument();
      });
    });

    it('shows MR section when pr step selected', async () => {
      renderForm({ showRunButton: false, showSaveButton: false });
      await waitFor(() => screen.getByText('Создание задачи'));

      fireEvent.click(screen.getByText('Добавить репозиторий'));
      await waitFor(() => expect(screen.getByText('org/repo-one')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('checkbox', { name: 'Merge Request' }));
      await waitFor(() => {
        expect(screen.getByText('Репозитории для MR')).toBeInTheDocument();
      });
    });

    it('сохраняет репозиторий с URL вне сохранённого списка, но без MR', async () => {
      const url = 'https://git.example.com/new/repo.git';
      const { onSubmit } = renderForm({
        initialData: {
          title: 'Draft',
          repositories: [
            { repo_id: '', repository_url: url, base_branch: 'main', create_mr: true },
          ],
        },
      });
      await waitFor(() => screen.getByText('Редактирование задачи'));

      const notice = screen.getByTestId('repo-url-unmatched');
      expect(notice).toHaveTextContent(url);
      expect(notice).toHaveTextContent('MR для него недоступен');

      fireEvent.click(screen.getByRole('checkbox', { name: 'Merge Request' }));
      await waitFor(() =>
        expect(screen.getByTestId('pr-repositories-section')).toBeInTheDocument(),
      );
      expect(
        screen.getByText(
          'Нет добавленных репозиториев с правом записи — MR не будет создан.',
        ),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      const payload = onSubmit.mock.calls[0][0] as CreateIssueRequest;
      expect(payload.repositories).toEqual([
        {
          repository_url: url,
          base_branch: 'main',
          create_mr: false,
          bootstrap_enabled: true,
        },
      ]);
    });

    it('create_mr для репозитория из сохранённого списка уезжает как true', async () => {
      const { onSubmit } = renderForm({
        initialData: {
          title: 'Draft',
          repositories: [{ repo_id: 'r1', base_branch: 'main', create_mr: true }],
          pipelineSteps: ['pr'],
        },
      });
      await waitFor(() => screen.getByText('Редактирование задачи'));

      fireEvent.click(screen.getByRole('button', { name: 'Запустить' }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      const payload = onSubmit.mock.calls[0][0] as CreateIssueRequest;
      expect(payload.repositories).toEqual([
        {
          repo_id: 'r1',
          base_branch: 'main',
          create_mr: true,
          bootstrap_enabled: true,
        },
      ]);
    });
  });
});