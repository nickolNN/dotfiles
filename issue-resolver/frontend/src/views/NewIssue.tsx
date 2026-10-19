import { useEffect, useState, type FormEvent } from 'react';
import type {
  CreateIssueRequest,
  DesiredResult,
  Issue,
  ModelDescriptor,
  PipelineStep,
  SavedRepo,
  StepModels,
  StepThinkingLevels,
  Tag,
  ThinkingLevel,
} from '@issue-resolver/shared';
import {
  createIssue,
  createIssueWithFiles,
  getModels,
  getRepositories,
  getRepositoryBranches,
  getTags,
} from '../api/client';
import FilePicker from '../components/FilePicker';
import JiraIssueUrlInput from '../components/JiraIssueUrlInput';
import MarkdownEditor from '../components/MarkdownEditor';
import { thinkingLevelsFor } from '../constants/thinking-levels';

/** Шаг пайплайна: одна строка = чекбокс шага + inline-селектор его модели. */
const MODEL_STEPS: ReadonlyArray<{ value: PipelineStep; label: string }> = [
  { value: 'refine', label: 'Планирование' },
  { value: 'resolve', label: 'Исполнение' },
  { value: 'review', label: 'Код-ревью' },
  { value: 'test', label: 'Тест' },
  { value: 'pr', label: 'Merge Request' },
];

/** Желаемый отчёт: формат (md/html). */
const DESIRED_RESULTS: ReadonlyArray<{ value: DesiredResult; label: string }> = [
  { value: 'md', label: 'Markdown (.md)' },
  { value: 'html', label: 'HTML (.html)' },
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

/** Строка формы репозитория: выбранный сохранённый репозиторий + его ветки. */
interface RepoRow {
  repo_id: string;
  base_branch: string;
  /** Ставить ли зависимости (bootstrapper) в этом репозитории. */
  bootstrap_enabled: boolean;
  branches: string[];
  branchesLoading: boolean;
}

export default function NewIssue({ onCreated, onBack }: NewIssueProps) {
  const [title, setTitle] = useState('');
  const [jiraIssueUrl, setJiraIssueUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<RepoRow[]>([]);
  const [savedRepos, setSavedRepos] = useState<SavedRepo[]>([]);
  const [savedReposLoading, setSavedReposLoading] = useState(true);
  const [savedReposError, setSavedReposError] = useState<string | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagId, setSelectedTagId] = useState('');
  const [additionalContext, setAdditionalContext] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [showJira, setShowJira] = useState(false);
  const [selectedSteps, setSelectedSteps] = useState<PipelineStep[]>([]);
  const [workerCount, setWorkerCount] = useState<number>(1);
  // id репозиториев, для которых на шаге pr нужно создать MR.
  const [prRepoIds, setPrRepoIds] = useState<Set<string>>(new Set());
  const [stepModels, setStepModels] = useState<StepModels>({});
  const [stepThinkingLevels, setStepThinkingLevels] =
    useState<StepThinkingLevels>({});
  const [bootstrapperModel, setBootstrapperModel] = useState('');
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

  // Сохранённые репозитории для селектора: грузим один раз при монтировании.
  useEffect(() => {
    let cancelled = false;
    setSavedReposLoading(true);

    getRepositories()
      .then((list) => {
        if (cancelled) return;
        setSavedRepos(Array.isArray(list) ? list : []);
        setSavedReposError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSavedRepos([]);
        setSavedReposError(
          err instanceof Error ? err.message : 'Не удалось загрузить репозитории',
        );
      })
      .finally(() => {
        if (cancelled) return;
        setSavedReposLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Теги для быстрого добавления их репозиториев: грузим один раз.
  useEffect(() => {
    let cancelled = false;
    getTags()
      .then((list) => {
        if (cancelled) return;
        setTags(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (cancelled) return;
        setTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function updateBaseBranch(index: number, value: string) {
    setRepositories((current) =>
      current.map((repository, i) =>
        i === index ? { ...repository, base_branch: value } : repository,
      ),
    );
  }

  /** Выбор сохранённого репозитория: defaultBranch + live-загрузка веток. */
  function selectRepository(index: number, repoId: string) {
    const saved = savedRepos.find((repo) => repo.id === repoId);
    setRepositories((current) =>
      current.map((repository, i) =>
        i === index
          ? {
              ...repository,
              repo_id: repoId,
              base_branch: saved?.defaultBranch ?? '',
              branches: [],
              branchesLoading: Boolean(repoId),
            }
          : repository,
      ),
    );

    if (!repoId) return;
    void getRepositoryBranches(repoId)
      .then((branches) => {
        setRepositories((current) =>
          current.map((repository, i) => {
            if (i !== index || repository.repo_id !== repoId) return repository;
            const options =
              repository.base_branch &&
              !branches.includes(repository.base_branch)
                ? [repository.base_branch, ...branches]
                : branches;
            return { ...repository, branches: options, branchesLoading: false };
          }),
        );
      })
      .catch(() => {
        setRepositories((current) =>
          current.map((repository, i) =>
            i === index && repository.repo_id === repoId
              ? { ...repository, branchesLoading: false }
              : repository,
          ),
        );
      });
  }

  /**
   * Применяет тег: добавляет все его репозитории строками формы, пропуская
   * уже выбранные, и подгружает ветки для новых строк. Сброс селекта — чтобы
   * можно было применить тот же тег ещё раз.
   */
  function selectTag(tagId: string) {
    setSelectedTagId('');
    const tag = tags.find((item) => item.id === tagId);
    if (!tag) return;

    const existing = new Set(
      repositories.map((repository) => repository.repo_id),
    );
    const additions: RepoRow[] = [];
    for (const tr of tag.repositories) {
      const repoId = tr.repository.id;
      if (!repoId || existing.has(repoId)) continue;
      existing.add(repoId);
      additions.push({
        repo_id: repoId,
        base_branch: tr.repository.defaultBranch ?? '',
        bootstrap_enabled: tr.bootstrap_enabled,
        branches: [],
        branchesLoading: true,
      });
    }
    if (additions.length === 0) return;

    setRepositories((current) => [...current, ...additions]);

    for (const row of additions) {
      void getRepositoryBranches(row.repo_id)
        .then((branches) => {
          setRepositories((current) =>
            current.map((repository) => {
              if (repository.repo_id !== row.repo_id) return repository;
              const options =
                repository.base_branch &&
                !branches.includes(repository.base_branch)
                  ? [repository.base_branch, ...branches]
                  : branches;
              return { ...repository, branches: options, branchesLoading: false };
            }),
          );
        })
        .catch(() => {
          setRepositories((current) =>
            current.map((repository) =>
              repository.repo_id === row.repo_id
                ? { ...repository, branchesLoading: false }
                : repository,
            ),
          );
        });
    }
  }

  function addRepository() {
    setRepositories((current) => [
      ...current,
      {
        repo_id: '',
        base_branch: '',
        bootstrap_enabled: true,
        branches: [],
        branchesLoading: false,
      },
    ]);
  }

  function togglePrRepo(repoId: string) {
    setPrRepoIds((current) => {
      const next = new Set(current);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  }

  function toggleRepositoryBootstrap(index: number) {
    setRepositories((current) =>
      current.map((repository, i) =>
        i === index
          ? {
              ...repository,
              bootstrap_enabled: !repository.bootstrap_enabled,
            }
          : repository,
      ),
    );
  }

  function removeRepository(index: number) {
    setRepositories((current) => current.filter((_, i) => i !== index));
  }

  function toggleStep(step: PipelineStep) {
    setSelectedSteps((current) =>
      current.includes(step)
        ? current.filter((value) => value !== step)
        : [...current, step],
    );
    // Сняли шаг pr — сбрасываем выбор репозиториев для MR.
    if (step === 'pr') {
      setPrRepoIds(new Set());
    }
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
  }

  function updateStepThinkingLevel(step: PipelineStep, value: string) {
    setStepThinkingLevels((current) => {
      const next: StepThinkingLevels = { ...current };
      if (value) {
        next[step] = value as ThinkingLevel;
      } else {
        delete next[step];
      }
      return next;
    });
  }

  // Модель шага доступна только когда шаг отмечен (resolve отмечен всегда).
  const chosenSteps = new Set<PipelineStep>(['resolve', ...selectedSteps]);

  // Репозитории с правом записи среди уже добавленных в форму —
  // именно для них можно запросить создание MR на шаге pr.
  const mrRepositories = repositories.filter(
    (repository) =>
      repository.repo_id &&
      savedRepos.find((repo) => repo.id === repository.repo_id)
        ?.writeAccess === true,
  );

  /** Собрать payload и отправить — общая для «Запустить» и «Сохранить». */
  async function submitIssue(runImmediately: boolean) {
    setError(null);
    setSubmitting(true);

    // В тело идут только модели выбранных шагов.
    const activeStepModels = Object.fromEntries(
      Object.entries(stepModels).filter(([step]) =>
        chosenSteps.has(step as PipelineStep),
      ),
    ) as StepModels;

    // В тело идут только thinking-уровни выбранных шагов.
    const activeStepThinkingLevels = Object.fromEntries(
      Object.entries(stepThinkingLevels).filter(([step]) =>
        chosenSteps.has(step as PipelineStep),
      ),
    ) as StepThinkingLevels;

    // В тело идут только строки с выбранным репозиторием — новый формат:
    // `repo_id` + `base_branch` + `create_mr` (URL подставляет бэкенд).
    // `bootstrap_enabled` пока не описан в shared-типах (его добавляет
    // бэкенд-агент), но уходит в тело всегда: по умолчанию — true.
    const activeRepositories = repositories
      .filter((repository) => repository.repo_id)
      .map((repository) => ({
        repo_id: repository.repo_id,
        base_branch: repository.base_branch,
        create_mr: chosenSteps.has('pr') && prRepoIds.has(repository.repo_id),
        bootstrap_enabled: repository.bootstrap_enabled,
      }));

    const payload: CreateIssueRequest = {
      title,
      jira_issue_url: jiraIssueUrl.trim() || undefined,
      repositories:
        activeRepositories.length > 0 ? activeRepositories : undefined,
      desired_result: desiredResult,
      additional_context: additionalContext.trim() || undefined,
      is_review_need: chosenSteps.has('review'),
      review_context: '',
      pipeline_steps: PIPELINE_ORDER.filter((step) => chosenSteps.has(step)),
      step_models:
        Object.keys(activeStepModels).length > 0 ? activeStepModels : undefined,
      bootstrapper_model: bootstrapperModel || undefined,
      step_thinking_levels:
        Object.keys(activeStepThinkingLevels).length > 0
          ? activeStepThinkingLevels
          : undefined,
      run_immediately: runImmediately,
      worker_count: workerCount > 0 ? workerCount : undefined,
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitIssue(true);
  }

  async function handleSave(event: React.MouseEvent) {
    event.preventDefault();
    await submitIssue(false);
  }

  return (
    <div className="mx-auto max-w-4xl py-6 px-3 sm:px-4 md:px-6">
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
          <legend className="mb-2 text-sm font-medium text-[#00FF41]/80">
            Теги
          </legend>
          <select
            id="issue-tag"
            data-testid="issue-tag-select"
            aria-label="Тег"
            className={inputClass}
            value={selectedTagId}
            onChange={(event) => selectTag(event.target.value)}
          >
            <option value="">
              Выберите тег (добавит все его репозитории)
            </option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </fieldset>

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
            {savedReposError && (
              <p role="alert" className="text-xs font-medium text-[#FF0033]">
                {savedReposError}
              </p>
            )}
            {repositories.map((repository, index) => {
              const selectedRepo = savedRepos.find(
                (repo) => repo.id === repository.repo_id,
              );
              // Опции веток: данные API, плюс текущее значение, если его нет.
              const branchOptions =
                repository.base_branch.length === 0
                  ? []
                  : repository.branches.includes(repository.base_branch)
                    ? repository.branches
                    : [repository.base_branch, ...repository.branches];
              return (
                <div
                  key={index}
                  data-testid="repo-row"
                  className="space-y-2 border border-[#008F11]/40 p-3"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-end">
                    <div className="min-w-0 flex-1">
                      <label
                        className={labelClass}
                        htmlFor={`repository-select-${index}`}
                      >
                        Репозиторий
                      </label>
                      <select
                        id={`repository-select-${index}`}
                        data-testid={`repository-select-${index}`}
                        className={inputClass}
                        value={repository.repo_id}
                        disabled={savedReposLoading}
                        onChange={(event) =>
                          selectRepository(index, event.target.value)
                        }
                      >
                        <option value="">
                          {savedReposLoading
                            ? 'Загружаем…'
                            : 'Выберите репозиторий'}
                        </option>
                        {savedRepos.map((repo) => (
                          <option key={repo.id} value={repo.id}>
                            {repo.fullName ?? repo.url}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="min-w-0 flex-1">
                      <label
                        className={labelClass}
                        htmlFor={`repository-branch-${index}`}
                      >
                        Базовая ветка
                      </label>
                      <select
                        id={`repository-branch-${index}`}
                        data-testid={`repository-branch-${index}`}
                        className={inputClass}
                        value={repository.base_branch}
                        disabled={
                          !repository.repo_id || repository.branchesLoading
                        }
                        onChange={(event) =>
                          updateBaseBranch(index, event.target.value)
                        }
                      >
                        {branchOptions.length === 0 && (
                          <option value="">
                            {repository.repo_id ? 'Загружаем…' : '—'}
                          </option>
                        )}
                        {branchOptions.map((branch) => (
                          <option key={branch} value={branch}>
                            {branch}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      className="min-h-12 w-full rounded-none border border-[#008F11] px-3 py-2 text-sm text-[#008F11] hover:bg-[#008F11]/20 hover:text-[#00FF41] disabled:opacity-40 md:w-auto"
                      onClick={() => removeRepository(index)}
                    >
                      Удалить
                    </button>
                  </div>
                  {selectedRepo && (
                    <p className="text-xs text-[#00FF41]/50">
                      {selectedRepo.url}
                      {selectedRepo.defaultBranch
                        ? ` · ветка по умолчанию: ${selectedRepo.defaultBranch}`
                        : ''}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={repository.bootstrap_enabled === true}
                      onClick={() => toggleRepositoryBootstrap(index)}
                      className="flex min-h-12 items-center gap-3 text-sm font-medium text-[#00FF41]/80"
                    >
                      <span
                        aria-hidden="true"
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center border transition-colors ${
                          repository.bootstrap_enabled
                            ? 'border-[#00FF41] bg-[#003B00]'
                            : 'border-[#008F11] bg-[#0D0208]'
                        }`}
                      >
                        <span
                          className={`absolute h-4 w-4 transition-transform ${
                            repository.bootstrap_enabled
                              ? 'translate-x-6 bg-[#00FF41]'
                              : 'translate-x-1 bg-[#008F11]'
                          }`}
                        />
                      </span>
                      Dev сервер
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {repositories.length === 0 && (
            <p className="mt-2 text-xs text-[#00FF41]/50">
              {!savedReposLoading && savedRepos.length === 0
                ? 'Нет сохранённых репозиториев — добавьте их на странице «Репозитории»'
                : 'Можно без репозиториев — агент запишет отчёт в папку задачи'}
            </p>
          )}
        </fieldset>

        <FilePicker id="issue-files" files={files} onChange={setFiles} />

        {showJira ? (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <button
                type="button"
                className="text-sm font-medium text-[#008F11] underline hover:text-[#00FF41]"
                onClick={() => {
                  setJiraIssueUrl('');
                  setShowJira(false);
                }}
              >
                Убрать
              </button>
            </div>
            <JiraIssueUrlInput
              value={jiraIssueUrl}
              onChange={(url) => setJiraIssueUrl(url)}
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

        {repositories.length > 0 && (
          <fieldset data-testid="bootstrapper-section">
            <legend className="mb-2 text-sm font-medium text-[#00FF41]/80">
              Bootstrapper проектов
            </legend>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <label
                className="text-sm text-[#00FF41]/80"
                htmlFor="bootstrapper-model"
              >
                Модель анализатора
              </label>
              <select
                id="bootstrapper-model"
                aria-label="Модель анализатора для bootstrapper'а проектов"
                className={`${inputClass} sm:w-64`}
                value={bootstrapperModel}
                onChange={(event) => setBootstrapperModel(event.target.value)}
                disabled={modelsLoading}
              >
                <option value="">По умолчанию</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name ?? model.id}
                  </option>
                ))}
              </select>
            </div>
          </fieldset>
        )}

        <fieldset data-testid="desired-result">
          <legend className="mb-2 text-sm font-medium text-[#00FF41]/80">
            Желаемый отчёт
          </legend>
          <div className="space-y-2">
            {DESIRED_RESULTS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 text-sm text-[#00FF41]/80"
              >
                <input
                  type="radio"
                  name="desired_result"
                  className="accent-[#00FF41]"
                  data-testid={`desired-result-${option.value}`}
                  value={option.value}
                  checked={desiredResult === option.value}
                  onChange={() => setDesiredResult(option.value)}
                />
                {option.label}
              </label>
            ))}
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
              const selectedModel = models.find(
                (model) => model.id === stepModels[step.value],
              );
              const thinkingLevels = thinkingLevelsFor(selectedModel);
              const thinkingEnabled = Boolean(stepModels[step.value]);
              return (
                <div
                  key={step.value}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-[#00FF41]/80">
                    <input
                      type="checkbox"
                      className="accent-[#00FF41]"
                      checked={checked}
                      disabled={isResolve}
                      onChange={() => toggleStep(step.value)}
                    />
                    {isResolve ? 'Исполнение (всегда)' : step.label}
                  </label>
                  {modelEnabled && (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
                      <select
                        aria-label={`Уровень размышления для шага ${step.label}`}
                        className={`${inputClass} sm:w-40`}
                        value={stepThinkingLevels[step.value] ?? ''}
                        onChange={(event) =>
                          updateStepThinkingLevel(step.value, event.target.value)
                        }
                        disabled={!thinkingEnabled}
                      >
                        <option value="">По умолчанию</option>
                        {thinkingEnabled &&
                          thinkingLevels.map((level) => (
                            <option key={level} value={level}>
                              {level}
                            </option>
                          ))}
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        <div>
          <label className="mb-1 block text-sm font-medium text-[#00FF41]/80" htmlFor="new-worker-count">
            Макс. число параллельных агентов
          </label>
          <input
            id="new-worker-count"
            type="number"
            min={0}
            max={4}
            value={workerCount}
            onChange={(event) =>
              setWorkerCount(Number(event.target.value) || 0)
            }
            className={`${inputClass} w-24`}
            data-testid="worker-count-input"
          />
          <p className="mt-1 text-xs text-[#00FF41]/40">
            0 — без ограничений, 1 — один агент, 2-4 — макс. N в комнате
          </p>
        </div>

        {selectedSteps.includes('pr') && (
          <fieldset data-testid="pr-repositories-section">
            <legend className="mb-2 text-sm font-medium text-[#00FF41]/80">
              Репозитории для MR
            </legend>
            {mrRepositories.length === 0 ? (
              <p className="text-xs text-[#00FF41]/50">
                Нет добавленных репозиториев с правом записи — MR не будет
                создан.
              </p>
            ) : (
              <div className="space-y-2">
                {mrRepositories.map((repository) => {
                  const selectedRepo = savedRepos.find(
                    (repo) => repo.id === repository.repo_id,
                  );
                  return (
                    <label
                      key={repository.repo_id}
                      className="flex cursor-pointer items-center gap-2 text-sm text-[#00FF41]/80"
                    >
                      <input
                        type="checkbox"
                        className="accent-[#00FF41]"
                        data-testid={`pr-repo-${repository.repo_id}`}
                        checked={prRepoIds.has(repository.repo_id)}
                        onChange={() => togglePrRepo(repository.repo_id)}
                      />
                      {selectedRepo?.fullName ?? repository.repo_id}
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
        )}

        {error && (
          <p role="alert" className="text-sm font-medium text-[#FF0033]">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="submit"
            disabled={submitting}
            className="min-h-12 w-full rounded-none border border-[#00FF41] bg-[#003B00] px-5 py-2 text-sm font-medium text-[#00FF41] shadow-[0_0_10px_rgba(0,255,65,0.35)] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 md:w-auto"
          >
            {submitting ? 'Запускаем…' : 'Запустить'}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={handleSave}
            className="min-h-12 w-full rounded-none border border-[#008F11] bg-[#0D0208] px-5 py-2 text-sm font-medium text-[#008F11] hover:bg-[#008F11]/20 hover:text-[#00FF41] disabled:opacity-50 md:w-auto"
          >
            {submitting ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </form>
    </div>
  );
}