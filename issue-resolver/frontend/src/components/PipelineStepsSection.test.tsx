import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ModelDescriptor, PipelineStep } from '@issue-resolver/shared';
import PipelineStepsSection, {
  type PipelineStepsSectionProps,
} from './PipelineStepsSection';

const MODELS: ModelDescriptor[] = [
  { id: 'gpt-4', name: 'GPT-4', thinkingLevels: ['off', 'low', 'medium'] },
  { id: 'opus', name: 'Claude Opus', thinkingLevels: ['off', 'xhigh'] },
];

const MR_REPOS = [
  { id: 'r1', label: 'org/repo-one' },
  { id: 'r2', label: 'org/repo-two' },
];

function renderSection(overrides: Partial<PipelineStepsSectionProps> = {}) {
  const onToggleStep = vi.fn();
  const onStepModelChange = vi.fn();
  const onStepThinkingChange = vi.fn();
  const onWorkerCountChange = vi.fn();
  const onTogglePrRepo = vi.fn();
  const view = render(
    <PipelineStepsSection
      selectedSteps={[] as PipelineStep[]}
      stepModels={{}}
      stepThinkingLevels={{}}
      models={MODELS}
      modelsLoading={false}
      mrRepoOptions={MR_REPOS}
      prRepoIds={new Set<string>()}
      onToggleStep={onToggleStep}
      onStepModelChange={onStepModelChange}
      onStepThinkingChange={onStepThinkingChange}
      onWorkerCountChange={onWorkerCountChange}
      onTogglePrRepo={onTogglePrRepo}
      {...overrides}
    />,
  );
  return {
    ...view,
    onToggleStep,
    onStepModelChange,
    onStepThinkingChange,
    onWorkerCountChange,
    onTogglePrRepo,
  };
}

describe('PipelineStepsSection', () => {
  afterEach(cleanup);

  it('resolve отмечен и снимается как любой другой шаг', () => {
    const { onToggleStep } = renderSection({
      selectedSteps: ['resolve', 'refine'],
    });

    const resolve = screen.getByRole('checkbox', { name: 'Исполнение' });
    expect(resolve).toBeChecked();
    expect(resolve).not.toBeDisabled();

    fireEvent.click(resolve);
    expect(onToggleStep).toHaveBeenCalledWith('resolve');

    expect(screen.getByRole('checkbox', { name: 'Планирование' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Тест' })).not.toBeChecked();
  });

  it('без resolve в selectedSteps: галочка снята, селектора модели нет', () => {
    renderSection({ selectedSteps: ['refine'] });

    expect(
      screen.getByRole('checkbox', { name: 'Исполнение' }),
    ).not.toBeChecked();
    expect(
      screen.queryByLabelText('Модель для шага Исполнение'),
    ).toBeNull();
  });

  it('клик по шагу зовёт onToggleStep', () => {
    const { onToggleStep } = renderSection();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Код-ревью' }));
    expect(onToggleStep).toHaveBeenCalledWith('review');
  });

  it('показывает модели и сбрасывает thinking без выбранной модели', () => {
    renderSection({ selectedSteps: ['refine'] });

    const modelSelect = screen.getByLabelText(
      'Модель для шага Планирование',
    ) as HTMLSelectElement;
    expect(modelSelect).not.toBeDisabled();
    expect(within(modelSelect).getByText('GPT-4')).toBeInTheDocument();

    expect(
      screen.getByLabelText('Уровень размышления для шага Планирование'),
    ).toBeDisabled();
  });

  it('thinking-опции строятся из выбранной модели', () => {
    const { onStepModelChange, onStepThinkingChange } = renderSection({
      selectedSteps: ['refine'],
      stepModels: { refine: 'gpt-4' },
    });

    const thinking = screen.getByLabelText(
      'Уровень размышления для шага Планирование',
    ) as HTMLSelectElement;
    expect(thinking).not.toBeDisabled();
    expect(within(thinking).getByText('medium')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Модель для шага Планирование'), {
      target: { value: 'opus' },
    });
    expect(onStepModelChange).toHaveBeenCalledWith('refine', 'opus');

    fireEvent.change(thinking, { target: { value: 'medium' } });
    expect(onStepThinkingChange).toHaveBeenCalledWith('refine', 'medium');
  });

  it('worker_count показывается у refine только когда значение задано', () => {
    const { onWorkerCountChange } = renderSection({ workerCount: 2 });

    const hint = screen.getByTestId('refine-planner-hint');
    const input = within(hint).getByTestId('worker-count-input') as HTMLInputElement;
    expect(input.value).toBe('2');

    fireEvent.change(input, { target: { value: '3' } });
    expect(onWorkerCountChange).toHaveBeenCalledWith(3);
  });

  it('без workerCount подсказки и инпута нет', () => {
    renderSection();
    expect(screen.queryByTestId('refine-planner-hint')).toBeNull();
    expect(screen.queryByTestId('worker-count-input')).toBeNull();
  });

  it('секция MR появляется только при выбранном pr и рендерит репозитории', () => {
    const { onTogglePrRepo } = renderSection({
      selectedSteps: ['pr'],
      prRepoIds: new Set(['r1']),
    });

    expect(screen.getByTestId('pr-repositories-section')).toBeInTheDocument();
    expect(screen.getByTestId('pr-repo-r1')).toBeChecked();
    expect(screen.getByTestId('pr-repo-r2')).not.toBeChecked();

    fireEvent.click(screen.getByTestId('pr-repo-r2'));
    expect(onTogglePrRepo).toHaveBeenCalledWith('r2');
  });

  it('без шага pr секции MR нет', () => {
    renderSection();
    expect(screen.queryByTestId('pr-repositories-section')).toBeNull();
  });

  it('пустой mrRepoOptions даёт сообщение, а не чекбоксы', () => {
    renderSection({ selectedSteps: ['pr'], mrRepoOptions: [] });
    expect(screen.getByTestId('pr-repositories-section')).toBeInTheDocument();
    expect(
      screen.getByText(/Нет добавленных репозиториев с правом записи/),
    ).toBeInTheDocument();
  });

  it('prDisabled блокирует pr, снимает галочку и прячет секцию MR', () => {
    renderSection({ selectedSteps: ['pr'], prDisabled: true });

    const pr = screen.getByRole('checkbox', {
      name: 'Merge Request (нужен репозиторий)',
    });
    expect(pr).toBeDisabled();
    expect(pr).not.toBeChecked();
    expect(screen.queryByTestId('pr-repositories-section')).toBeNull();
  });

  it('disabled дизейблит все контролы', () => {
    renderSection({
      selectedSteps: ['refine'],
      workerCount: 1,
      disabled: true,
    });

    expect(screen.getByRole('checkbox', { name: 'Планирование' })).toBeDisabled();
    expect(
      screen.getByLabelText('Модель для шага Планирование'),
    ).toBeDisabled();
    expect(screen.getByTestId('worker-count-input')).toBeDisabled();
  });

  it('stepOptions переопределяет подписи (модалка итерации: PR)', () => {
    renderSection({
      stepOptions: [
        { value: 'refine', label: 'Планирование' },
        { value: 'resolve', label: 'Исполнение' },
        { value: 'pr', label: 'PR' },
      ],
    });

    expect(screen.getByRole('checkbox', { name: 'PR' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Тест' })).toBeNull();
  });
});