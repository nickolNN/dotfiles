import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type {
  CreateIssueRequest,
  ModelDescriptor,
  PipelineStep,
  StepModels,
  StepThinkingLevels,
  ThinkingLevel,
} from '@issue-resolver/shared';
import { getModels, getRepositoryBranches } from '../api/client';
import { thinkingLevelsFor } from '../constants/thinking-levels';
import { usePipelineSteps } from '../hooks/usePipelineSteps';
import { useSavedRepos, useTags } from '../stores/queries';
import FilePicker from './FilePicker';
import JiraIssueUrlInput from './JiraIssueUrlInput';
import MarkdownEditor from './MarkdownEditor';
import ModelThinkingSelect from './ModelThinkingSelect';
import PipelineStepsSection from './PipelineStepsSection';
import QueryBoundary from './QueryBoundary';
import RepoRow, { type RepoRowData } from './RepoRow';
import { inputClass, labelClass } from './formStyles';

/** Канонический порядок шагов пайплайна: порядок в форме не должен
 * переставлять `resolve` вперёд `refine` и остальных шагов. */
const PIPELINE_ORDER: readonly PipelineStep[] = [
  'refine',
  'resolve',
  'review',
  'test',
  'pr',
];

/** Репозиторий в начальных данных формы (создание/редактирование). */
interface InitialRepository {
  repo_id: string;
  /** URL репозитория — приходит для строк, не найденных среди сохранённых. */
  repository_url?: string;
  base_branch: string;
  bootstrap_enabled?: boolean;
  create_mr?: boolean;
}

export interface IssueFormProps {
  /** Начальные значения (undefined для создания, заполненные для редактирования). */
  initialData?: {
    title?: string;
    description?: string;
    jiraIssueUrl?: string;
    repositories?: InitialRepository[];
    pipelineSteps?: PipelineStep[];
    stepModels?: StepModels;
    stepThinkingLevels?: StepThinkingLevels;
    devopsModel?: string;
    /** Thinking effort DevOps-агента («шаг девопса»), как у остальных шагов. */
    devopsThinkingLevel?: ThinkingLevel | null;
    /** Сохранённое число исполнителей задачи (без него форма всегда начинала с 1). */
    workerCount?: number | null;
  };
  /** Вызывается при submit. Для NewIssue: createIssue, для edit: updateIssue. */
  onSubmit: (payload: CreateIssueRequest, files: File[]) => Promise<void>;
  /** Текст на кнопке submit («Запустить»). */
  submitLabel?: string;
  /** Показать кнопку «Сохранить» (runImmediately=false). */
  showSaveButton?: boolean;
  /** Показать кнопку «Запустить» (runImmediately=true). */
  showRunButton?: boolean;
  /** Показать секцию файлов. */
  showFiles?: boolean;
  /** Внешняя ошибка (от mutation). */
  error?: string | null;
  /** Флаг отправки. */
  submitting?: boolean;
  onBack?: () => void;
  /** Режим без обёртки: без внешнего div, header и back-кнопки — для модалок. */
  headerless?: boolean;
}

/**
 * Общая форма задачи: создание и редактирование. Всё состояние и вся логика
 * живут внутри; наружу отдаётся только собранный payload через `onSubmit`.
 * API-мутации (create/update) подключает вызывающий — форма про них не знает.
 */
export default function IssueForm(props: IssueFormProps) {
  return (
    <QueryBoundary>
      <IssueFormView {...props} />
    </QueryBoundary>
  );
}

function IssueFormView({
  initialData,
  onSubmit,
  submitLabel = 'Запустить',
  showSaveButton = true,
  showRunButton = true,
  showFiles = true,
  error = null,
  submitting = false,
  onBack,
  headerless = false,
}: IssueFormProps) {
  const [title, setTitle] = useState(initialData?.title ?? '');
  const [jiraIssueUrl, setJiraIssueUrl] = useState(initialData?.jiraIssueUrl ?? '');
  const [repositories, setRepositories] = useState<RepoRowData[]>(() =>
    (initialData?.repositories ?? []).map((repository) => ({
      repo_id: repository.repo_id,
      repository_url: repository.repository_url,
      base_branch: repository.base_branch,
      bootstrap_enabled: repository.bootstrap_enabled ?? true,
      branches: [],
      branchesLoading: Boolean(repository.repo_id),
    })),
  );
  const [selectedTagId, setSelectedTagId] = useState('');
  const [additionalContext, setAdditionalContext] = useState(
    initialData?.description ?? '',
  );
  const [files, setFiles] = useState<File[]>([]);
  const [showJira, setShowJira] = useState(Boolean(initialData?.jiraIssueUrl));
  const [workerCount, setWorkerCount] = useState(initialData?.workerCount ?? 1);
  const [devOpsModel, setDevOpsModel] = useState(
    initialData?.devopsModel ?? '',
  );
  // Thinking effort DevOps-агента — отдельное поле, НЕ элемент step-карты:
  // DevOps не является PipelineStep, и `step_thinking_levels` его не вместиит.
  const [devOpsThinkingLevel, setDevOpsThinkingLevel] = useState<
    ThinkingLevel | ''
  >(initialData?.devopsThinkingLevel ?? '');
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  // Варианты thinking для DevOps-агента — из той же таблицы моделей, что и
  // для шагов: набор уровней зависит от выбранной модели.
  const devOpsThinkingLevels = thinkingLevelsFor(
    models.find((model) => model.id === devOpsModel),
  );
  const [modelsLoading, setModelsLoading] = useState(true);

  // Шаги пайплайна, их модели/thinking и репозитории для MR.
  const {
    selectedSteps,
    stepModels,
    stepThinkingLevels,
    chosenSteps,
    prRepoIds,
    toggleStep,
    updateStepModel,
    updateStepThinkingLevel,
    togglePrRepo,
  } = usePipelineSteps({
    models,
    initialSteps: (initialData?.pipelineSteps ?? []).filter(
      (step) => step !== 'resolve',
    ),
    initialStepModels: initialData?.stepModels,
    initialStepThinkingLevels: initialData?.stepThinkingLevels,
    initialPrRepoIds: (initialData?.repositories ?? [])
      // Пустой `repo_id` = репозиторий задан URL'ом и не найден среди
      // сохранённых: он не попадёт в список MR-опций, а `''` в множестве
      // сбивал бы проверку «выбор пуст» и глушил автовыбор по умолчанию.
      .filter((repository) => repository.create_mr && repository.repo_id)
      .map((repository) => repository.repo_id),
  });

  // Серверные данные формы: сохранённые репозитории и теги — через react-query.
  const {
    data: savedRepos = [],
    isLoading: savedReposLoading,
    error: savedReposError,
  } = useSavedRepos();
  const { data: tags = [] } = useTags();
  const savedReposErrorText =
    savedReposError instanceof Error
      ? savedReposError.message
      : savedReposError
        ? String(savedReposError)
        : null;

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

  // Ветки для репозиториев, пришедших из initialData, запрашиваются live:
  // в самом initialData их нет.
  const initialRepositoriesRef = useRef(initialData?.repositories);
  useEffect(() => {
    const initial = initialRepositoriesRef.current ?? [];
    let cancelled = false;

    for (const row of initial) {
      if (!row.repo_id) continue;
      void getRepositoryBranches(row.repo_id)
        .then((branches) => {
          if (cancelled) return;
          setRepositories((current) =>
            current.map((repository) => {
              if (repository.repo_id !== row.repo_id) return repository;
              const options =
                repository.base_branch &&
                !branches.includes(repository.base_branch)
                  ? [repository.base_branch, ...branches]
                  : branches;
              return {
                ...repository,
                branches: options,
                branchesLoading: false,
              };
            }),
          );
        })
        .catch(() => {
          if (cancelled) return;
          setRepositories((current) =>
            current.map((repository) =>
              repository.repo_id === row.repo_id
                ? { ...repository, branchesLoading: false }
                : repository,
            ),
          );
        });
    }

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
    const additions: RepoRowData[] = [];
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
              return {
                ...repository,
                branches: options,
                branchesLoading: false,
              };
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

  // Репозитории с правом записи среди уже добавленных в форму —
  // именно для них можно запросить создание MR на шаге pr.
  const mrRepositories = repositories.filter(
    (repository) =>
      repository.repo_id &&
      savedRepos.find((repo) => repo.id === repository.repo_id)
        ?.writeAccess === true,
  );

  /** Собрать payload и отправить — общая для «Запустить» и «Сохранить». */
  async function submitForm(runImmediately: boolean) {
    // В тело идут только модели выбранных шагов. `report` — не шаг пайплайна
    // (отчёт всегда генерируется движком на терминальной итерации), поэтому
    // его модель сохраняется независимо от набора выбранных шагов.
    const activeStepModels = Object.fromEntries(
      Object.entries(stepModels).filter(
        ([step]) => step === 'report' || chosenSteps.has(step as PipelineStep),
      ),
    ) as StepModels;

    // В тело идут thinking-уровни выбранных шагов. `report` — не шаг
    // пайплайна, но его уровень сохраняется независимо от набора шагов
    // (симметрично `report` в `activeStepModels`).
    const activeStepThinkingLevels = Object.fromEntries(
      Object.entries(stepThinkingLevels).filter(
        ([step]) => step === 'report' || chosenSteps.has(step as PipelineStep),
      ),
    ) as StepThinkingLevels;

    // В тело идут только осмысленные строки. Сохранённый репозиторий — как
    // `repo_id`; репозиторий вне сохранённого списка — явным `repository_url`,
    // чтобы он не пропал. `create_mr` для URL-строки всегда false: право
    // записи неизвестно, MR для неё недоступен (и в UI секции MR её нет).
    const activeRepositories: NonNullable<CreateIssueRequest['repositories']> =
      [];
    for (const repository of repositories) {
      if (repository.repo_id) {
        activeRepositories.push({
          repo_id: repository.repo_id,
          base_branch: repository.base_branch,
          create_mr: chosenSteps.has('pr') && prRepoIds.has(repository.repo_id),
          bootstrap_enabled: repository.bootstrap_enabled,
        });
      } else if (repository.repository_url) {
        activeRepositories.push({
          repository_url: repository.repository_url,
          base_branch: repository.base_branch,
          create_mr: false,
          bootstrap_enabled: repository.bootstrap_enabled,
        });
      }
    }

    const payload: CreateIssueRequest = {
      title,
      jira_issue_url: jiraIssueUrl.trim() || undefined,
      repositories:
        activeRepositories.length > 0 ? activeRepositories : undefined,
      additional_context: additionalContext.trim() || undefined,
      is_review_need: chosenSteps.has('review'),
      review_context: '',
      pipeline_steps: PIPELINE_ORDER.filter((step) => chosenSteps.has(step)),
      step_models:
        Object.keys(activeStepModels).length > 0 ? activeStepModels : undefined,
      devops_model: devOpsModel || undefined,
      devops_thinking_level: devOpsThinkingLevel || undefined,
      step_thinking_levels:
        Object.keys(activeStepThinkingLevels).length > 0
          ? activeStepThinkingLevels
          : undefined,
      run_immediately: runImmediately,
      worker_count: workerCount > 0 ? workerCount : undefined,
    };

    try {
      await onSubmit(payload, files);
      setFiles([]);
    } catch {
      // Ошибку показывает проп `error` (mutation на стороне вызывающего).
      // Файлы не чистим, чтобы пользователь мог повторить отправку без
      // повторного выбора вложений.
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitForm(true);
  }

  function handleSave(event: ReactMouseEvent) {
    event.preventDefault();
    void submitForm(false);
  }

  // Common form JSX used by both page and modal variants.
  const formBody = (
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
            {savedReposErrorText && (
              <p role="alert" className="text-xs font-medium text-[#FF0033]">
                {savedReposErrorText}
              </p>
            )}
            {repositories.map((repository, index) => (
              <RepoRow
                key={index}
                repo={repository}
                index={index}
                savedRepos={savedRepos}
                savedReposLoading={savedReposLoading}
                onSelectRepo={selectRepository}
                onUpdateBranch={updateBaseBranch}
                onToggleBootstrap={toggleRepositoryBootstrap}
                onRemove={removeRepository}
              />
            ))}
          </div>
          {repositories.length === 0 && (
            <p className="mt-2 text-xs text-[#00FF41]/50">
              {!savedReposLoading && savedRepos.length === 0
                ? 'Нет сохранённых репозиториев — добавьте их на странице «Репозитории»'
                : 'Можно без репозиториев — агент запишет отчёт в папку задачи'}
            </p>
          )}
        </fieldset>

        {showFiles && (
          <FilePicker id="issue-files" files={files} onChange={setFiles} />
        )}

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
          <fieldset data-testid="devops-section">
            <legend className="mb-2 text-sm font-medium text-[#00FF41]/80">
              DevOps проектов
            </legend>
            <ModelThinkingSelect
              models={models}
              thinkingLevels={devOpsThinkingLevels}
              modelValue={devOpsModel}
              thinkingValue={devOpsThinkingLevel}
              disabled={modelsLoading}
              thinkingDisabled={!devOpsModel}
              modelLabel="Модель анализатора"
              thinkingLabel="Thinking effort анализатора"
              modelTestId="devops-model-input"
              thinkingTestId="devops-thinking-input"
              modelAriaLabel="Модель анализатора для DevOps-агента проектов"
              thinkingAriaLabel="Thinking effort для DevOps-агента проектов"
              modelSelectClassName={`${inputClass} sm:w-64`}
              thinkingSelectClassName={`${inputClass} sm:w-64`}
              onModelChange={setDevOpsModel}
              onThinkingChange={(value) =>
                setDevOpsThinkingLevel(value as ThinkingLevel | '')
              }
            />
          </fieldset>
        )}

        <PipelineStepsSection
          selectedSteps={selectedSteps}
          stepModels={stepModels}
          stepThinkingLevels={stepThinkingLevels}
          models={models}
          modelsLoading={modelsLoading}
          workerCount={workerCount}
          mrRepoOptions={mrRepositories.map((repository) => ({
            id: repository.repo_id,
            label:
              savedRepos.find((repo) => repo.id === repository.repo_id)
                ?.fullName ?? repository.repo_id,
          }))}
          prRepoIds={prRepoIds}
          onToggleStep={toggleStep}
          onStepModelChange={updateStepModel}
          onStepThinkingChange={updateStepThinkingLevel}
          onWorkerCountChange={setWorkerCount}
          onTogglePrRepo={togglePrRepo}
        />

        {/* Модель и thinking report-агента. `report` не отмечается как шаг
            пайплайна — отчёт движок запускает сам на терминальной итерации, —
            но его модель и уровень живут в общих картах `step_models` /
            `step_thinking_levels` (как и у остальных шагов). */}
        <fieldset data-testid="report-section">
          <legend className="mb-2 text-sm font-medium text-[#00FF41]/80">
            Отчёт
          </legend>
          <ModelThinkingSelect
            models={models}
            thinkingLevels={thinkingLevelsFor(
              models.find((model) => model.id === stepModels.report),
            )}
            modelValue={stepModels.report ?? ''}
            thinkingValue={stepThinkingLevels.report ?? ''}
            disabled={modelsLoading}
            thinkingDisabled={!stepModels.report}
            modelLabel="Модель отчёта"
            thinkingLabel="Thinking effort отчёта"
            modelTestId="report-model-input"
            thinkingTestId="report-thinking-input"
            modelAriaLabel="Модель агента отчёта"
            thinkingAriaLabel="Thinking effort агента отчёта"
            modelSelectClassName={`${inputClass} sm:w-64`}
            thinkingSelectClassName={`${inputClass} sm:w-64`}
            onModelChange={(value) => updateStepModel('report', value)}
            onThinkingChange={(value) =>
              updateStepThinkingLevel('report', value)
            }
          />
        </fieldset>

        {error && (
          <p role="alert" className="text-sm font-medium text-[#FF0033]">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row">
          {showRunButton && (
            <button
              type="submit"
              disabled={submitting}
              className="min-h-12 w-full rounded-none border border-[#00FF41] bg-[#003B00] px-5 py-2 text-sm font-medium text-[#00FF41] shadow-[0_0_10px_rgba(0,255,65,0.35)] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 md:w-auto"
            >
              {submitting ? 'Запускаем…' : submitLabel}
            </button>
          )}
          {showSaveButton && (
            <button
              type="button"
              disabled={submitting}
              onClick={handleSave}
              className="min-h-12 w-full rounded-none border border-[#008F11] bg-[#0D0208] px-5 py-2 text-sm font-medium text-[#008F11] hover:bg-[#008F11]/20 hover:text-[#00FF41] disabled:opacity-50 md:w-auto"
            >
              {submitting ? 'Сохраняем…' : 'Сохранить'}
            </button>
          )}
        </div>
      </form>
  );

  if (headerless) {
    return formBody;
  }

  return (
    <div className="mx-auto max-w-4xl py-6 px-3 sm:px-4 md:px-6">
      <header className="mb-6">
        {onBack && (
          <button
            type="button"
            className="mb-3 hidden min-h-12 text-sm font-medium text-[#008F11] hover:text-[#00FF41] sm:inline-flex"
            onClick={onBack}
          >
            ← Мои задачи
          </button>
        )}
        <h2 className="glow text-xl font-semibold text-[#00FF41]">
          {initialData ? 'Редактирование задачи' : 'Создание задачи'}
        </h2>
        <p className="text-sm text-[#00FF41]/60">
          Опишите задачу и репозитории, в которых её нужно решить.
        </p>
      </header>
      {formBody}
    </div>
  );
}