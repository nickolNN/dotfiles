import { useEffect, useState, type FormEvent } from 'react';
import type {
  CreateIssueRequest,
  DesiredResult,
  Issue,
  ModelDescriptor,
  PipelineStep,
  RepositoryInput,
  StepModels,
} from '@issue-resolver/shared';
import {
  createIssue,
  createIssueWithFiles,
  getModels,
} from '../api/client';
import FilePicker from '../components/FilePicker';
import MarkdownEditor from '../components/MarkdownEditor';

/** Шаг пайплайна: одна строка = чекбокс шага + inline-селектор его модели. */
const MODEL_STEPS: ReadonlyArray<{ value: PipelineStep; label: string }> = [
  { value: 'refine', label: 'Refine' },
  { value: 'resolve', label: 'Resolve' },
  { value: 'review', label: 'Review' },
  { value: 'test', label: 'Test' },
];

/** Желаемый результат задачи: артефакт (md/html) или PR. */
const DESIRED_RESULTS: ReadonlyArray<{ value: DesiredResult; label: string }> = [
  { value: 'md', label: 'Markdown (.md)' },
  { value: 'html', label: 'HTML (.html)' },
  { value: 'pr', label: 'PR (merge request)' },
];

const inputClass =
  'w-full rounded-none border border-[#008F11] bg-[#0D0208] px-3 py-2 text-sm text-[#00FF41] outline-none placeholder:text-[#008F11] focus:border-[#00FF41] focus:shadow-[0_0_8px_rgba(0,255,65,0.35)]';
const labelClass = 'mb-1 block text-sm font-medium text-[#00FF41]/80';

/** Канонический порядок шагов пайплайна: порядок в форме не должен
 * переставлять `resolve` вперёд `refine` и остальных шагов. */
const PIPELINE_ORDER: readonly PipelineStep[] = [
  'refine',
  'resolve',
  'review',
  'test',
  'pr',
];

interface NewIssueProps {
  onCreated?: (issue: Issue) => void;
  onBack?: () => void;
}

export default function NewIssue({ onCreated, onBack }: NewIssueProps) {
  const [title, setTitle] = useState('');
  const [jiraIssueUrl, setJiraIssueUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<RepositoryInput[]>([]);
  const [additionalContext, setAdditionalContext] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [showJira, setShowJira] = useState(false);
  const [selectedSteps, setSelectedSteps] = useState<PipelineStep[]>([]);
  const [stepModels, setStepModels] = useState<StepModels>({});
  const [desiredResult, setDesiredResult] = useState<DesiredResult>('md');
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);

    getModels()
      .then((list) => {
        if (cancelled) return;
        setModels(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        // Ошибка загрузки моделей не должна ронять форму — просто пустой список.
        if (cancelled) return;
        setModels([]);
      })
      .finally(() => {
        if (cancelled) return;
        setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function updateRepository(
    index: number,
    field: keyof RepositoryInput,
    value: string,
  ) {
    setRepositories((current) =>
      current.map((repository, i) =>
        i === index ? { ...repository, [field]: value } : repository,
      ),
    );
  }

  function addRepository() {
    setRepositories((current) => [
      ...current,
      { repository_url: '', base_branch: 'dev', create_mr: false },
    ]);
  }

  function toggleRepositoryMr(index: number) {
    setRepositories((current) =>
      current.map((repository, i) =>
        i === index
          ? { ...repository, create_mr: !repository.create_mr }
          : repository,
      ),
    );
  }

  function removeRepository(index: number) {
    setRepositories((current) => current.filter((_, i) => i !== index));
  }

  // PR доступен только при наличии хотя бы одного репозитория.
  const prAvailable = repositories.length > 0;

  function toggleStep(step: PipelineStep) {
    setSelectedSteps((current) =>
      current.includes(step)
        ? current.filter((value) => value !== step)
        : [...current, step],
    );
  }

  function updateStepModel(step: PipelineStep, value: string) {
    setStepModels((current) => {
      const next: StepModels = { ...current };
      if (value) {
        next[step] = value;
      } else {
        delete next[step];
      }
      return next;
    });
  }

  // Модель шага доступна только когда шаг отмечен (resolve отмечен всегда).
  const chosenSteps = new Set<PipelineStep>(['resolve', ...selectedSteps]);

  // Удалили последний репозиторий — PR-результат больше недоступен, откат на md.
  useEffect(() => {
    if (!prAvailable && desiredResult === 'pr') setDesiredResult('md');
  }, [prAvailable, desiredResult]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    // В тело идут только модели выбранных шагов.
    const activeStepModels = Object.fromEntries(
      Object.entries(stepModels).filter(([step]) =>
        chosenSteps.has(step as PipelineStep),
      ),
    ) as StepModels;

    const payload: CreateIssueRequest = {
      title,
      jira_issue_url: jiraIssueUrl.trim() || undefined,
      repositories,
      desired_result: desiredResult,
      additional_context: additionalContext.trim() || undefined,
      is_review_need: chosenSteps.has('review'),
      review_context: '',
      pipeline_steps: PIPELINE_ORDER.filter((step) => chosenSteps.has(step)),
      step_models:
        Object.keys(activeStepModels).length > 0 ? activeStepModels : undefined,
    };

    try {
      const issue =
        files.length > 0
          ? await createIssueWithFiles(payload, files)
          : await createIssue(payload);
      setFiles([]);
      onCreated?.(issue);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel mx-auto max-w-3xl py-6 px-3 sm:px-4 md:px-6">
      <header className="mb-6">
        <button
          type="button"
          className="mb-3 hidden min-h-12 text-sm font-medium text-[#008F11] hover:text-[#00FF41] sm:inline-flex"
          onClick={() => onBack?.()}
        >
          ← Мои задачи
        </button>
        <h2 className="glow text-xl font-semibold text-[#00FF41]">
          Создание задачи
        </h2>
        <p className="text-sm text-[#00FF41]/60">
          Опишите задачу и репозитории, в которых её нужно решить.
        </p>
      </header>

      <form className="space-y-6" onSubmit={handleSubmit}>
        <div>
          <label className={labelClass} htmlFor="title">
            Заголовок
          </label>
          <input
            id="title"
            className={inputClass}
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Коротко о задаче"
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="additional_context">
            Описание задачи
          </label>
          <MarkdownEditor
            id="additional_context"
            value={additionalContext}
            onChange={setAdditionalContext}
            placeholder="Опишите, что нужно сделать"
            aria-label="Описание задачи"
            minHeight="6rem"
          />
        </div>

        <fieldset>
          <div className="mb-2 flex items-center justify-between">
            <legend className="text-sm font-medium text-[#00FF41]/80">
              Репозитории
            </legend>
            <button
              type="button"
              className="text-sm font-medium text-[#008F11] underline hover:text-[#00FF41]"
              onClick={addRepository}
            >
              Добавить репозиторий
            </button>
          </div>
          <div className="space-y-3">
            {repositories.map((repository, index) => (
              <div
                key={index}
                className="space-y-2 border border-[#008F11]/40 p-3"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-end">
                <div className="min-w-0 flex-1">
                  <label
                    className={labelClass}
                    htmlFor={`repository-url-${index}`}
                  >
                    Адрес
                  </label>
                  <input
                    id={`repository-url-${index}`}
                    className={inputClass}
                    type="text"
                    value={repository.repository_url}
                    onChange={(event) =>
                      updateRepository(index, 'repository_url', event.target.value)
                    }
                    placeholder="git@github.com:org/repo.git"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <label
                    className={labelClass}
                    htmlFor={`repository-branch-${index}`}
                  >
                    Базовая ветка
                  </label>
                  <input
                    id={`repository-branch-${index}`}
                    className={inputClass}
                    type="text"
                    value={repository.base_branch}
                    onChange={(event) =>
                      updateRepository(index, 'base_branch', event.target.value)
                    }
                    placeholder="dev"
                  />
                </div>
                <button
                  type="button"
                  className="min-h-12 w-full rounded-none border border-[#008F11] px-3 py-2 text-sm text-[#008F11] hover:bg-[#008F11]/20 hover:text-[#00FF41] disabled:opacity-40 md:w-auto"
                  onClick={() => removeRepository(index)}
                >
                  Удалить
                </button>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={repository.create_mr === true}
                  onClick={() => toggleRepositoryMr(index)}
                  className="flex min-h-12 items-center gap-3 text-sm font-medium text-[#00FF41]/80"
                >
                  <span
                    aria-hidden="true"
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center border transition-colors ${
                      repository.create_mr
                        ? 'border-[#00FF41] bg-[#003B00]'
                        : 'border-[#008F11] bg-[#0D0208]'
                    }`}
                  >
                    <span
                      className={`absolute h-4 w-4 transition-transform ${
                        repository.create_mr
                          ? 'translate-x-6 bg-[#00FF41]'
                          : 'translate-x-1 bg-[#008F11]'
                      }`}
                    />
                  </span>
                  Создать merge request
                </button>
              </div>
            ))}
          </div>
          {repositories.length === 0 && (
            <p className="mt-2 text-xs text-[#00FF41]/50">
              Можно без репозиториев — агент запишет результаты в папку задачи
            </p>
          )}
        </fieldset>

        <FilePicker id="issue-files" files={files} onChange={setFiles} />

        {showJira ? (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className={`${labelClass} mb-0`} htmlFor="jira_issue_url">
                Ссылка на Jira
              </label>
              <button
                type="button"
                className="text-sm font-medium text-[#008F11] underline hover:text-[#00FF41]"
                onClick={() => setShowJira(false)}
              >
                Убрать
              </button>
            </div>
            <input
              id="jira_issue_url"
              className={inputClass}
              type="url"
              value={jiraIssueUrl}
              onChange={(event) => setJiraIssueUrl(event.target.value)}
              placeholder="https://jira.example.com/browse/PROJ-123"
            />
          </div>
        ) : (
          <button
            type="button"
            className="text-sm font-medium text-[#008F11] underline hover:text-[#00FF41]"
            onClick={() => setShowJira(true)}
          >
            Добавить ссылку на Jira
          </button>
        )}

        <fieldset data-testid="desired-result">
          <legend className="mb-2 text-sm font-medium text-[#00FF41]/80">
            Желаемый результат
          </legend>
          <div className="space-y-2">
            {DESIRED_RESULTS.map((option) => {
              const disabled = option.value === 'pr' && !prAvailable;
              return (
                <label
                  key={option.value}
                  className="flex items-center gap-2 text-sm text-[#00FF41]/80"
                >
                  <input
                    type="radio"
                    name="desired_result"
                    className="accent-[#00FF41]"
                    data-testid={`desired-result-${option.value}`}
                    value={option.value}
                    checked={desiredResult === option.value}
                    disabled={disabled}
                    onChange={() => setDesiredResult(option.value)}
                  />
                  {option.label}
                  {disabled && (
                    <span className="text-xs text-[#00FF41]/40">
                      {' '}
                      (нужен репозиторий)
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-[#00FF41]/80">
            Шаги пайплайна и модели
          </legend>
          <div className="space-y-3">
            {MODEL_STEPS.map((step) => {
              const isResolve = step.value === 'resolve';
              const checked = isResolve || selectedSteps.includes(step.value);
              const modelEnabled = chosenSteps.has(step.value);
              return (
                <div
                  key={step.value}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <label className="flex items-center gap-2 text-sm text-[#00FF41]/80">
                    <input
                      type="checkbox"
                      className="accent-[#00FF41]"
                      checked={checked}
                      disabled={isResolve}
                      onChange={() => toggleStep(step.value)}
                    />
                    {isResolve ? 'Resolve (всегда)' : step.label}
                  </label>
                  {modelEnabled && (
                    <select
                      aria-label={`Модель для шага ${step.label}`}
                      className={`${inputClass} sm:w-64`}
                      value={stepModels[step.value] ?? ''}
                      onChange={(event) =>
                        updateStepModel(step.value, event.target.value)
                      }
                      disabled={modelsLoading}
                    >
                      <option value="">По умолчанию</option>
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name ?? model.id}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        {error && (
          <p role="alert" className="text-sm font-medium text-[#FF0033]">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="min-h-12 w-full rounded-none border border-[#00FF41] bg-[#003B00] px-5 py-2 text-sm font-medium text-[#00FF41] shadow-[0_0_10px_rgba(0,255,65,0.35)] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 md:w-auto"
        >
          {submitting ? 'Запускаем…' : 'Запустить'}
        </button>
      </form>
    </section>
  );
}