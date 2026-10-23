import { useMemo, useState } from 'react';
import type {
  CreateIssueRequest,
  Issue,
  SavedRepo,
} from '@issue-resolver/shared';
import { updateIssue } from '../api/client';
import { useSavedRepos } from '../stores/queries';
import IssueForm from './IssueForm';
import type { IssueFormProps } from './IssueForm';

/**
 * Модалка редактирования черновика задачи.
 *
 * Форма живёт в общем `IssueForm` — тот же код, что на странице создания
 * задачи. Здесь только диалог, предзаполнение из `Issue` и отправка в
 * `PUT /issues/:id`.
 */
export interface EditDraftModalProps {
  issue: Issue;
  onClose: () => void;
  /** Вызывается после успешного сохранения с обновлённой задачей. */
  onSaved: (issue: Issue) => void;
}

/** Обратное преобразование `Issue` → предзаполнение для `IssueForm`. */
function toInitialData(
  issue: Issue,
  savedRepos: SavedRepo[],
): IssueFormProps['initialData'] {
  return {
    title: issue.title,
    description: issue.description,
    jiraIssueUrl: issue.jira_issue_url ?? '',
    // Задача хранит URL репозитория, форма — id сохранённого репозитория.
    repositories: issue.repositories.map((repository) => {
      const saved = savedRepos.find(
        (candidate) =>
          candidate.url === repository.repository_url ||
          candidate.cloneUrl === repository.repository_url,
      );
      return {
        repo_id: saved?.id ?? '',
        base_branch: repository.branch_name,
        bootstrap_enabled: repository.bootstrap_enabled,
        create_mr: repository.create_mr,
      };
    }),
    pipelineSteps: issue.pipeline_steps,
    stepModels: issue.step_models ?? {},
    stepThinkingLevels: issue.step_thinking_levels ?? {},
    devopsModel: issue.devops_model ?? '',
    devopsThinkingLevel: issue.devops_thinking_level ?? null,
    workerCount: issue.worker_count ?? null,
  };
}

export default function EditDraftModal({
  issue,
  onClose,
  onSaved,
}: EditDraftModalProps) {
  const { data: savedRepos = [] } = useSavedRepos();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Предзаполнение считаем один раз на открытие: `IssueForm` держит своё
  // состояние и не должна пересоздаваться на каждый рефетч задачи.
  const initialData = useMemo(
    () => toInitialData(issue, savedRepos),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [issue.id],
  );

  const lostRepos =
    initialData?.repositories?.filter((repository) => !repository.repo_id)
      .length ?? 0;

  async function handleSubmit(payload: CreateIssueRequest) {
    setError(null);
    setSaving(true);
    try {
      const updated = await updateIssue(issue.id, {
        title: payload.title,
        description: payload.additional_context,
        desired_result: payload.desired_result,
        jira_issue_url: payload.jira_issue_url ?? null,
        pipeline_steps: payload.pipeline_steps,
        step_models: payload.step_models,
        thinking_level: payload.thinking_level,
        step_thinking_levels: payload.step_thinking_levels,
        devops_model: payload.devops_model ?? null,
        devops_thinking_level: payload.devops_thinking_level ?? null,
        worker_count: payload.worker_count ?? null,
        repositories: payload.repositories,
      });
      onSaved(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      data-testid="edit-draft-modal"
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#0D0208]/90 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        className="my-auto w-full max-w-3xl rounded-none border border-[#008F11] bg-[#0D0208] p-6 shadow-[0_0_30px_rgba(0,255,65,0.2)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="glow text-lg font-semibold text-[#00FF41]">
            Редактировать черновик
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="px-2 text-lg leading-none text-[#00FF41]/60 hover:text-[#00FF41]"
          >
            ✕
          </button>
        </div>

        {error && (
          <p role="alert" className="mb-4 text-sm font-medium text-[#FF0033]">
            {error}
          </p>
        )}

        {lostRepos > 0 && (
          <p className="mb-4 text-xs text-[#FFB000]">
            {lostRepos} репозиториев не найдено среди сохранённых — MR для них
            недоступен. Сами репозитории сохранятся по URL.
          </p>
        )}

        {/* Кнопку «Сохранить» рендерит сама форма — отсюда только отмена. */}
        <IssueForm
          headerless
          initialData={initialData}
          onSubmit={(payload) => handleSubmit(payload)}
          submitLabel="Сохранить"
          showRunButton
          showSaveButton={false}
          submitting={saving}
          error={null}
        />

        <div className="mt-4">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="min-h-12 rounded-none border border-[#008F11] px-5 py-2 text-sm font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] disabled:opacity-50"
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
