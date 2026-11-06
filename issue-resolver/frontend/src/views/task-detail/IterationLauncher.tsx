import type { ModelDescriptor } from "@issue-resolver/shared";
import { TaskStatus } from "@issue-resolver/shared";
import IterationFormModal from "./IterationFormModal";
import { repoFullNameFromUrl } from "../repoPrep";
import type { IterationActions } from "./useIterationActions";
import type { IterationForm } from "./useIterationForm";
import type { LoadState } from "./types";
import { AsyncStateStatus } from '../../lib/async-state';

interface IterationLauncherProps {
  state: LoadState;
  form: IterationForm;
  actions: IterationActions;
  models: ModelDescriptor[];
  modelsLoading: boolean;
}

export default function IterationLauncher({
  state,
  form,
  actions,
  models,
  modelsLoading,
}: IterationLauncherProps) {
  const repoOptions =
    state.status === AsyncStateStatus.ready
      ? state.data.issue.repositories.map((repository) => ({
          id: repository.id,
          label: repoFullNameFromUrl(repository.repository_url),
        }))
      : [];

  return (
    <>
      {state.status === AsyncStateStatus.ready && state.data.issue.status === TaskStatus.draft && (
        <section className="rounded-none border border-[#008F11] p-4">
          <h3 className="glow mb-1 text-lg font-semibold text-[#00FF41]">
            Черновик
          </h3>
          <p className="mb-4 text-sm text-[#00FF41]/60">
            Задача сохранена как черновик. Запустите её, чтобы начать
            скачивание репозиториев и выполнение пайплайна.
          </p>
          {actions.startDraftError && (
            <p
              role="alert"
              className="mb-3 text-sm font-medium text-[#FF0033]"
            >
              {actions.startDraftError}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={actions.startingDraft}
              onClick={() => void actions.handleStartDraft()}
              className="min-h-12 rounded-none border border-[#00FF41] bg-[#003B00] px-5 py-2 text-sm font-medium text-[#00FF41] shadow-[0_0_10px_rgba(0,255,65,0.35)] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50"
            >
              {actions.startingDraft ? "Запускаем…" : "Запустить"}
            </button>
            <button
              type="button"
              disabled={actions.startingDraft}
              data-testid="open-iteration-modal"
              onClick={() => form.setShowIterationModal(true)}
              className="min-h-12 rounded-none border border-[#00B4FF] px-5 py-2 text-sm font-medium text-[#00B4FF] hover:bg-[#00B4FF] hover:text-[#0D0208] disabled:opacity-50"
            >
              Редактировать
            </button>
          </div>
        </section>
      )}

      {}
      {form.canStart &&
        state.status === AsyncStateStatus.ready &&
        state.data.issue.status !== TaskStatus.draft && (
          <button
            type="button"
            data-testid="open-iteration-modal"
            onClick={() => {
              if (form.hasDraftIteration && state.status === AsyncStateStatus.ready) {
                const draft = state.data.iterations.find(
                  (it) => it.status === TaskStatus.draft,
                );
                if (draft) form.setContext(draft.context ?? "");
              }
              form.setShowIterationModal(true);
            }}
            className="min-h-12 w-full rounded-none border border-[#00FF41] bg-[#003B00] px-5 py-2 text-sm font-medium text-[#00FF41] shadow-[0_0_10px_rgba(0,255,65,0.35)] hover:bg-[#00FF41] hover:text-[#0D0208] md:w-auto"
          >
            {form.hasDraftIteration ? "Редактировать черновик" : "Новая итерация"}
          </button>
        )}

      {}
      {form.showIterationModal && (
        <IterationFormModal
          form={{
            ...form,
            models,
            modelsLoading,
            repoOptions,
          }}
          actions={{
            onSubmit: form.handleSubmit,
            onClose: () => form.setShowIterationModal(false),
            setContext: form.setContext,
            setFiles: form.setFiles,
            setWorkerCount: form.setWorkerCount,
            onToggleStep: form.toggleStep,
            onStepModelChange: form.updateStepModel,
            onStepThinkingChange: form.updateStepThinkingLevel,
            onTogglePrRepo: form.togglePrRepo,
          }}
        />
      )}
    </>
  );
}
