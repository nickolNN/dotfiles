import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type {
  ModelDescriptor,
  PipelineStep,
  StepModels,
  StepThinkingLevels,
  ThinkingLevel,
} from '@issue-resolver/shared';
import { thinkingLevelsFor } from '../constants/thinking-levels';

export interface UsePipelineStepsOptions {
  /** Каталог моделей: нужен, чтобы сбросить несовместимый thinking-уровень. */
  models: ModelDescriptor[];
  /** Блокирует шаг pr (модалка итерации: нет репозитория с правом записи). */
  prAvailable?: boolean;
  /** Стартовые отмеченные шаги (в форме — из initialData). */
  initialSteps?: PipelineStep[];
  initialStepModels?: StepModels;
  initialStepThinkingLevels?: StepThinkingLevels;
  /** Стартовый выбор репозиториев для MR. */
  initialPrRepoIds?: Iterable<string>;
  /**
   * id, которые выбираются при включении шага pr, если выбор ещё пуст
   * (модалка итерации: все репозитории задачи). По умолчанию — ничего.
   */
  defaultPrRepoIds?: ReadonlyArray<string>;
}

export interface UsePipelineStepsResult {
  selectedSteps: PipelineStep[];
  stepModels: StepModels;
  stepThinkingLevels: StepThinkingLevels;
  /** Selected steps; payload models/steps are filtered by this set. */
  chosenSteps: Set<PipelineStep>;
  prRepoIds: Set<string>;
  toggleStep: (step: PipelineStep) => void;
  updateStepModel: (step: PipelineStep, value: string) => void;
  updateStepThinkingLevel: (step: PipelineStep, value: string) => void;
  togglePrRepo: (repoId: string) => void;
  setSelectedSteps: Dispatch<SetStateAction<PipelineStep[]>>;
  setStepModels: Dispatch<SetStateAction<StepModels>>;
  setStepThinkingLevels: Dispatch<SetStateAction<StepThinkingLevels>>;
  setPrRepoIds: Dispatch<SetStateAction<Set<string>>>;
}

/**
 * Единственный источник step-стейта формы задачи и модалки итерации:
 * отмеченные шаги, их модели/thinking-уровни и выбор репозиториев для MR.
 * Логика при переключении шага pr и сбросе несовместимого thinking-уровня
 * живёт здесь — раньше дублировалась в `IssueForm` и `TaskDetail`.
 */
export function usePipelineSteps({
  models,
  prAvailable = true,
  initialSteps,
  initialStepModels,
  initialStepThinkingLevels,
  initialPrRepoIds,
  defaultPrRepoIds,
}: UsePipelineStepsOptions): UsePipelineStepsResult {
  const [selectedSteps, setSelectedSteps] = useState<PipelineStep[]>(
    () => initialSteps ?? [],
  );
  const [stepModels, setStepModels] = useState<StepModels>(
    () => initialStepModels ?? {},
  );
  const [stepThinkingLevels, setStepThinkingLevels] =
    useState<StepThinkingLevels>(() => initialStepThinkingLevels ?? {});
  const [prRepoIds, setPrRepoIds] = useState<Set<string>>(
    () => new Set(initialPrRepoIds ?? []),
  );

  const toggleStep = useCallback(
    (step: PipelineStep) => {
      if (step === 'pr' && !prAvailable) return;

      const willEnable = !selectedSteps.includes(step);
      setSelectedSteps((current) =>
        current.includes(step)
          ? current.filter((value) => value !== step)
          : [...current, step],
      );

      if (step === 'pr') {
        if (willEnable) {
          // Включили pr — если ничего не выбрано, берём набор по умолчанию.
          setPrRepoIds((current) =>
            current.size === 0 ? new Set(defaultPrRepoIds ?? []) : current,
          );
        } else {
          // Сняли pr — сбрасываем выбор репозиториев для MR.
          setPrRepoIds(new Set());
        }
      }
    },
    [defaultPrRepoIds, prAvailable, selectedSteps],
  );

  const updateStepModel = useCallback(
    (step: PipelineStep, value: string) => {
      setStepModels((current) => {
        const next: StepModels = { ...current };
        if (value) {
          next[step] = value;
        } else {
          delete next[step];
        }
        return next;
      });

      // Смена модели сбрасывает уровень, несовместимый с её thinkingLevels.
      const allowed = value
        ? thinkingLevelsFor(models.find((model) => model.id === value))
        : [];
      setStepThinkingLevels((current) => {
        const level = current[step];
        if (!level || (value && allowed.includes(level))) return current;
        const next: StepThinkingLevels = { ...current };
        delete next[step];
        return next;
      });
    },
    [models],
  );

  const updateStepThinkingLevel = useCallback(
    (step: PipelineStep, value: string) => {
      setStepThinkingLevels((current) => {
        const next: StepThinkingLevels = { ...current };
        if (value) {
          next[step] = value as ThinkingLevel;
        } else {
          delete next[step];
        }
        return next;
      });
    },
    [],
  );

  const togglePrRepo = useCallback((repoId: string) => {
    setPrRepoIds((current) => {
      const next = new Set(current);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  }, []);

  const chosenSteps = useMemo(
    () => new Set<PipelineStep>(selectedSteps),
    [selectedSteps],
  );

  return {
    selectedSteps,
    stepModels,
    stepThinkingLevels,
    chosenSteps,
    prRepoIds,
    toggleStep,
    updateStepModel,
    updateStepThinkingLevel,
    togglePrRepo,
    setSelectedSteps,
    setStepModels,
    setStepThinkingLevels,
    setPrRepoIds,
  };
}