import type { ComponentProps, FormEvent } from "react";
import type { ModelDescriptor } from "@issue-resolver/shared";
import FilePicker from "../../components/FilePicker";
import FormError from "../../components/FormError";
import MarkdownEditor from "../../components/MarkdownEditor";
import ModalShell from "../../components/ModalShell";
import PipelineStepsSection from "../../components/PipelineStepsSection";
import { STEP_OPTIONS, labelClass } from "./constants";

type FilePickerProps = ComponentProps<typeof FilePicker>;
type StepsProps = ComponentProps<typeof PipelineStepsSection>;

interface IterationFormValues {
  context: string;
  files: FilePickerProps["files"];
  selectedSteps: StepsProps["selectedSteps"];
  stepModels: StepsProps["stepModels"];
  stepThinkingLevels: StepsProps["stepThinkingLevels"];
  workerCount: number;
  prRepoIds: StepsProps["prRepoIds"];
  prAvailable: boolean;
  models: ModelDescriptor[];
  modelsLoading: boolean;
  repoOptions: { id: string; label: string }[];
  canStart: boolean;
  hasIterationSteps: boolean;
  hasDraftIteration: boolean;
  submitting: boolean;
  submitButtonLabel: string;
  hint: string;
  formError: string | null;
}

interface IterationFormActions {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  setContext: (value: string) => void;
  setFiles: FilePickerProps["onChange"] extends (files: infer F) => void ? (files: F) => void : never;
  setWorkerCount: (value: number) => void;
  onToggleStep: StepsProps["onToggleStep"];
  onStepModelChange: StepsProps["onStepModelChange"];
  onStepThinkingChange: StepsProps["onStepThinkingChange"];
  onTogglePrRepo: StepsProps["onTogglePrRepo"];
}

export default function IterationFormModal({
  form,
  actions,
}: {
  form: IterationFormValues;
  actions: IterationFormActions;
}) {
  const {
    context,
    files,
    selectedSteps,
    stepModels,
    stepThinkingLevels,
    workerCount,
    prRepoIds,
    prAvailable,
    models,
    modelsLoading,
    repoOptions,
    canStart,
    hasIterationSteps,
    hasDraftIteration,
    submitting,
    submitButtonLabel,
    hint,
    formError,
  } = form;
  const { setContext, setFiles, setWorkerCount } = actions;
  return (
    <ModalShell
      onClose={() => actions.onClose()}
      overlayTestId="iteration-modal-backdrop"
      cardTestId="new-iteration-island"
      title={
        <h3 className="glow text-lg font-semibold text-[#00FF41]">
          {hasDraftIteration ? "Редактировать черновик" : "Новая итерация"}
        </h3>
      }
      classes={{
        overlay: "bg-[#0D0208]/90 backdrop-blur-sm",
        card: "border-[#008F11] bg-[#0D0208] p-4 shadow-[0_0_30px_rgba(0,255,65,0.2)]",
        header: "mb-1",
      }}
    >
      <p className="mb-4 text-sm text-[#00FF41]/60">
        {hasDraftIteration
          ? "Отредактируй контекст черновика и сохрани изменения."
          : "Добавь новый контекст и запусти ещё одну попытку решения задачи."}
      </p>

      <form className="space-y-4" onSubmit={actions.onSubmit}>
        <div>
          <label className={labelClass} htmlFor="iteration-context">
            Контекст итерации
          </label>
          <MarkdownEditor
            id="iteration-context"
            value={context}
            onChange={setContext}
            disabled={!canStart}
            placeholder="Например: попробуй другой подход, обрати внимание на обработку ошибок и добавь тесты…"
            aria-label="Контекст итерации"
            minHeight="6rem"
          />
        </div>

        <FilePicker
          id="iteration-files"
          files={files}
          onChange={setFiles}
          disabled={!canStart}
        />

        <PipelineStepsSection
          selectedSteps={selectedSteps}
          stepModels={stepModels}
          stepThinkingLevels={stepThinkingLevels}
          models={models}
          modelsLoading={modelsLoading}
          workerCount={workerCount}
          onWorkerCountChange={setWorkerCount}
          mrRepoOptions={repoOptions}
          prRepoIds={prRepoIds}
          prDisabled={!prAvailable}
          disabled={!canStart}
          stepOptions={STEP_OPTIONS}
          onToggleStep={actions.onToggleStep}
          onStepModelChange={actions.onStepModelChange}
          onStepThinkingChange={actions.onStepThinkingChange}
          onTogglePrRepo={actions.onTogglePrRepo}
        />

        <FormError message={formError} />

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="text-xs text-[#00FF41]/60">{hint}</p>
          <button
            type="submit"
            disabled={
              !canStart || !hasIterationSteps || !context.trim() || submitting
            }
            className="min-h-12 w-full rounded-none border border-[#00FF41] bg-[#003B00] px-5 py-2 text-sm font-medium text-[#00FF41] shadow-[0_0_10px_rgba(0,255,65,0.35)] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 md:w-auto transition-base"
          >
            {submitting ? "Создание итерации…" : submitButtonLabel}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}