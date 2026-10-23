import type {
  ModelDescriptor,
  PipelineStep,
  StepModels,
  StepThinkingLevels,
} from '@issue-resolver/shared';
import { thinkingLevelsFor } from '../constants/thinking-levels';
import { compactInputClass, labelClass } from './formStyles';
import StepRow from './StepRow';

/** Шаги пайплайна: порядок и подписи по умолчанию (форма задачи/итерации). */
export const DEFAULT_STEP_OPTIONS: ReadonlyArray<{
  value: PipelineStep;
  label: string;
}> = [
  { value: 'refine', label: 'Планирование' },
  { value: 'resolve', label: 'Исполнение' },
  { value: 'review', label: 'Код-ревью' },
  { value: 'test', label: 'Тест' },
  { value: 'pr', label: 'Merge Request' },
];

const WORKER_COUNT_TITLE =
  'Планируем — решает, запускать ли resolve комнатой агентов; без Планирования всегда ровно один агент. 0 — без ограничений, 1 — один агент, 2-4 — макс. N в комнате.';

export interface PipelineStepOption {
  value: PipelineStep;
  label: string;
}

export interface PipelineStepsSectionProps {
  /** Отмеченные шаги; `resolve` можно не включать — он всегда отмечен внутри. */
  selectedSteps: PipelineStep[];
  stepModels: StepModels;
  stepThinkingLevels: StepThinkingLevels;
  models: ModelDescriptor[];
  modelsLoading: boolean;
  /** Число агентов: инпут показывается только когда значение задано. */
  workerCount?: number;
  /** id репозиториев задачи — для секции MR (в форме: repo_id, в модалке: id). */
  mrRepoOptions: Array<{ id: string; label: string }>;
  prRepoIds: Set<string>;
  /** Заблокировать шаг pr (нет репозиториев с правом записи). */
  prDisabled?: boolean;
  /** Общий fieldset disabled (модалка итерации: !canStart). */
  disabled?: boolean;
  onToggleStep: (step: PipelineStep) => void;
  onStepModelChange: (step: PipelineStep, value: string) => void;
  onStepThinkingChange: (step: PipelineStep, value: string) => void;
  onWorkerCountChange?: (value: number) => void;
  onTogglePrRepo: (repoId: string) => void;
  /** Переопределить подписи/порядок шагов (модалка итерации: `pr` → «PR»). */
  stepOptions?: ReadonlyArray<PipelineStepOption>;
}

/**
 * Секция «шаги пайплайна + модели + thinking + worker_count + репозитории
 * для MR». Управляемая: всё состояние живёт у родителя, поэтому один и тот
 * же компонент используют и `IssueForm`, и модалка итерации в `TaskDetail`.
 */
export default function PipelineStepsSection({
  selectedSteps,
  stepModels,
  stepThinkingLevels,
  models,
  modelsLoading,
  workerCount,
  mrRepoOptions,
  prRepoIds,
  prDisabled = false,
  disabled = false,
  onToggleStep,
  onStepModelChange,
  onStepThinkingChange,
  onWorkerCountChange,
  onTogglePrRepo,
  stepOptions = DEFAULT_STEP_OPTIONS,
}: PipelineStepsSectionProps) {
  // `resolve` отмечен всегда — независимо от того, пришёл он в selectedSteps.
  const chosenSteps = new Set<PipelineStep>(['resolve', ...selectedSteps]);
  const showWorkerCount = workerCount !== undefined && onWorkerCountChange;
  const showPrRepositories = selectedSteps.includes('pr') && !prDisabled;

  return (
    <>
      <fieldset disabled={disabled}>
        <legend className={labelClass}>Шаги пайплайна и модели</legend>
        <div className="space-y-3">
          {stepOptions.map((step) => {
            const isResolve = step.value === 'resolve';
            const prBlocked = step.value === 'pr' && prDisabled;
            const checked =
              isResolve || (!prBlocked && selectedSteps.includes(step.value));
            const modelEnabled = chosenSteps.has(step.value) && !prBlocked;
            const selectedModel = models.find(
              (model) => model.id === stepModels[step.value],
            );
            const labelSuffix = isResolve
              ? ' (всегда)'
              : prBlocked
                ? ' (нужен репозиторий)'
                : undefined;

            return (
              <StepRow
                key={step.value}
                step={step}
                checked={checked}
                disabled={disabled || isResolve || prBlocked}
                labelSuffix={labelSuffix}
                modelEnabled={modelEnabled}
                thinkingLevels={thinkingLevelsFor(selectedModel)}
                thinkingEnabled={Boolean(stepModels[step.value])}
                currentModel={stepModels[step.value] ?? ''}
                currentThinkingLevel={stepThinkingLevels[step.value] ?? ''}
                models={models}
                modelsLoading={modelsLoading}
                onToggle={onToggleStep}
                onModelChange={onStepModelChange}
                onThinkingChange={onStepThinkingChange}
                hint={
                  step.value === 'refine' && showWorkerCount ? (
                    <label
                      data-testid="refine-planner-hint"
                      className="flex items-center gap-2 text-xs text-[#00FF41]/60"
                      htmlFor="worker-count"
                      title={WORKER_COUNT_TITLE}
                    >
                      Макс. число параллельных агентов
                      <input
                        id="worker-count"
                        type="number"
                        min={0}
                        max={4}
                        value={workerCount}
                        onChange={(event) =>
                          onWorkerCountChange(Number(event.target.value) || 0)
                        }
                        className={compactInputClass}
                        data-testid="worker-count-input"
                      />
                    </label>
                  ) : undefined
                }
              />
            );
          })}
        </div>
      </fieldset>

      {showPrRepositories && (
        <fieldset data-testid="pr-repositories-section" disabled={disabled}>
          <legend className={labelClass}>Репозитории для MR</legend>
          {mrRepoOptions.length === 0 ? (
            <p className="text-xs text-[#00FF41]/50">
              Нет добавленных репозиториев с правом записи — MR не будет создан.
            </p>
          ) : (
            <div className="space-y-2">
              {mrRepoOptions.map((repository) => (
                <label
                  key={repository.id}
                  className="flex cursor-pointer items-center gap-2 text-sm text-[#00FF41]/80"
                >
                  <input
                    type="checkbox"
                    className="accent-[#00FF41]"
                    data-testid={`pr-repo-${repository.id}`}
                    checked={prRepoIds.has(repository.id)}
                    onChange={() => onTogglePrRepo(repository.id)}
                  />
                  {repository.label}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}
    </>
  );
}