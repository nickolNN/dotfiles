import { messageOf } from "../../lib/errors";
import { useMemo, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import {
  PipelineStep,
  TaskStatus,
  canStartIteration,
  isIterationActive,
  type CreateIterationRequest,
  type ModelDescriptor,
  type StepModels,
  type StepThinkingLevels,
} from "@issue-resolver/shared";
import {
  createIteration,
  createIterationWithFiles,
  getIterations,
  updateIteration,
} from "../../api/client";
import { usePipelineSteps } from "../../hooks/usePipelineSteps";
import { PIPELINE_ORDER } from "../../constants/pipeline";
import { withIterations } from "./load-state";
import type { LoadState } from "./types";
import { AsyncStateStatus } from '../../lib/async-state';

const REVIEW_HINT = "После Resolver автоматически запустится Код-ревью.";

function submitLabel(hasDraft: boolean, hasActive: boolean): string {
  if (hasDraft) return "Сохранить черновик";
  if (hasActive) return "Создать черновик";
  return "Запустить новую итерацию";
}

function iterationHint(
  hasSteps: boolean,
  hasContext: boolean,
  reviewsAfter: boolean,
): string {
  if (!hasSteps) return "Отметь хотя бы один шаг пайплайна.";
  if (!hasContext) return "Укажи контекст для новой итерации.";
  if (reviewsAfter) return REVIEW_HINT;
  return "Итерация завершится сразу после работы Resolver.";
}

function pickStepValues<T>(
  values: Partial<Record<PipelineStep, T>>,
  chosenSteps: ReadonlySet<PipelineStep>,
  prAvailable: boolean,
): Partial<Record<PipelineStep, T>> {
  const picked: Partial<Record<PipelineStep, T>> = {};
  for (const step of PIPELINE_ORDER) {
    if (!chosenSteps.has(step)) continue;
    if (step === PipelineStep.pr && !prAvailable) continue;
    const value = values[step];
    if (value !== undefined) picked[step] = value;
  }
  return picked;
}

interface UseIterationFormInput {
  issueId: string | null | undefined;
  state: LoadState;
  models: ModelDescriptor[];
  setState: Dispatch<SetStateAction<LoadState>>;
  onCreated: () => void;
}

export function useIterationForm({
  issueId,
  state,
  models,
  setState,
  onCreated,
}: UseIterationFormInput) {
  const [context, setContext] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [workerCount, setWorkerCount] = useState<number>(0);
  const [prRepoIdsSeeded, setPrRepoIdsSeeded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showIterationModal, setShowIterationModal] = useState(false);
  const [scrollToIterations, setScrollToIterations] = useState(false);

  const iterationPrRepoDefaults = useMemo(
    () =>
      state.status === AsyncStateStatus.ready
        ? state.data.issue.repositories.map((repository) => repository.id)
        : [],
    [state],
  );
  const {
    selectedSteps,
    setSelectedSteps,
    stepModels,
    stepThinkingLevels,
    prRepoIds,
    setPrRepoIds,
    chosenSteps,
    toggleStep,
    updateStepModel,
    updateStepThinkingLevel,
    togglePrRepo,
  } = usePipelineSteps({
    models,
    initialSteps: ["resolve"],
    prAvailable:
      state.status === AsyncStateStatus.ready && state.data.issue.repositories.length > 0,
    defaultPrRepoIds: iterationPrRepoDefaults,
  });

  const hasActiveIteration =
    state.status === AsyncStateStatus.ready
      ? state.data.iterations.some((it) => isIterationActive(it.status))
      : false;
  const hasDraftIteration =
    state.status === AsyncStateStatus.ready
      ? state.data.iterations.some((it) => it.status === TaskStatus.draft)
      : false;
  const canStartNormal =
    state.status === AsyncStateStatus.ready ? canStartIteration(state.data.iterations) : false;
  const canStartDraftForm = hasActiveIteration && !hasDraftIteration;
  const canStart = canStartNormal || canStartDraftForm;
  const submitButtonLabel = submitLabel(hasDraftIteration, hasActiveIteration);
  const prAvailable =
    state.status === AsyncStateStatus.ready && state.data.issue.repositories.length > 0;
  const selectedRunSteps = PIPELINE_ORDER.filter(
    (step) => chosenSteps.has(step) && (step !== PipelineStep.pr || prAvailable),
  );
  const hasIterationSteps = selectedRunSteps.length > 0;
  const hint = iterationHint(
    hasIterationSteps,
    context.trim().length > 0,
    selectedSteps.includes("review"),
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!issueId) return;
    if (!canStart || !hasIterationSteps) return;

    const issue = state.status === AsyncStateStatus.ready ? state.data.issue : null;

    const effectiveSteps = selectedRunSteps;

    const activeStepModels: StepModels = pickStepValues(
      stepModels,
      chosenSteps,
      prAvailable,
    );

    const activeStepThinkingLevels: StepThinkingLevels = pickStepValues(
      stepThinkingLevels,
      chosenSteps,
      prAvailable,
    );

    const request: CreateIterationRequest = {
      context,
      is_review_need: selectedSteps.includes("review"),
      review_context: "",
      steps: effectiveSteps,
      step_models:
        Object.keys(activeStepModels).length > 0 ? activeStepModels : undefined,
      step_thinking_levels:
        Object.keys(activeStepThinkingLevels).length > 0
          ? activeStepThinkingLevels
          : undefined,
      pr_repository_ids: selectedSteps.includes("pr") ? [...prRepoIds] : [],
      worker_count: workerCount > 0 ? workerCount : undefined,
    };

    setFormError(null);
    setSubmitting(true);

    try {
      if (hasDraftIteration) {
        const draft =
          state.status === AsyncStateStatus.ready
            ? state.data.iterations.find((it) => it.status === TaskStatus.draft)
            : undefined;
        if (!draft) throw new Error("Черновик не найден");
        await updateIteration(draft.id, { context });
      } else if (files.length > 0) {
        await createIterationWithFiles(issueId, request, files);
      } else {
        await createIteration(issueId, request);
      }
      const iterations = await getIterations(issueId);
      setState((current) => withIterations(current, iterations));
      setContext("");
      setFiles([]);
      setSelectedSteps(issue?.pipeline_steps ?? []);
      setWorkerCount(0);
      setScrollToIterations(true);
      onCreated();
      setShowIterationModal(false);
    } catch (error) {
      setFormError(messageOf(error));
    } finally {
      setSubmitting(false);
    }
  }

  return {
    context,
    setContext,
    files,
    setFiles,
    workerCount,
    setWorkerCount,
    prRepoIdsSeeded,
    setPrRepoIdsSeeded,
    submitting,
    setSubmitting,
    formError,
    setFormError,
    showIterationModal,
    setShowIterationModal,
    scrollToIterations,
    setScrollToIterations,
    selectedSteps,
    setSelectedSteps,
    stepModels,
    stepThinkingLevels,
    prRepoIds,
    setPrRepoIds,
    chosenSteps,
    toggleStep,
    updateStepModel,
    updateStepThinkingLevel,
    togglePrRepo,
    hasActiveIteration,
    hasDraftIteration,
    canStartNormal,
    canStartDraftForm,
    canStart,
    submitButtonLabel,
    prAvailable,
    selectedRunSteps,
    hasIterationSteps,
    hint,
    handleSubmit,
  };
}

export type IterationForm = ReturnType<typeof useIterationForm>;