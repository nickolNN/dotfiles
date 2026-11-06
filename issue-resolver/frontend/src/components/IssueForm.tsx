import {
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react';
import { PipelineStep } from '@issue-resolver/shared';
import type { ThinkingLevel } from '@issue-resolver/shared';
import { usePipelineSteps } from '../hooks/usePipelineSteps';
import FormError from './FormError';
import PipelineStepsSection from './PipelineStepsSection';
import QueryBoundary from './QueryBoundary';
import DevopsModelField from './issue-form/DevopsModelField';
import IssueBasics from './issue-form/IssueBasics';
import JiraField from './issue-form/JiraField';
import ReportModelField from './issue-form/ReportModelField';
import RepositoriesField from './issue-form/RepositoriesField';
import { buildIssuePayload } from './issue-form/payload';
import type { IssueFormProps } from './issue-form/types';
import { useIssueRepositories } from './issue-form/useIssueRepositories';
import { useModels } from '../hooks/useModels';

export type { IssueFormProps } from './issue-form/types';

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
  const [jiraIssueUrl, setJiraIssueUrl] = useState(
    initialData?.jiraIssueUrl ?? '',
  );
  const [showJira, setShowJira] = useState(Boolean(initialData?.jiraIssueUrl));
  const [additionalContext, setAdditionalContext] = useState(
    initialData?.description ?? '',
  );
  const [files, setFiles] = useState<File[]>([]);
  const [workerCount, setWorkerCount] = useState(initialData?.workerCount ?? 0);
  const [devOpsModel, setDevOpsModel] = useState(
    initialData?.devopsModel ?? '',
  );
  const [devOpsThinkingLevel, setDevOpsThinkingLevel] = useState<
    ThinkingLevel | ''
  >(initialData?.devopsThinkingLevel ?? '');

  const { models, modelsLoading } = useModels();
  const {
    repositories,
    savedRepos,
    savedReposLoading,
    savedReposErrorText,
    tags,
    mrRepositories,
    updateBaseBranch,
    selectRepository,
    selectTag,
    addRepository,
    toggleRepositoryBootstrap,
    removeRepository,
  } = useIssueRepositories(initialData?.repositories);

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
    initialSteps: initialData?.pipelineSteps ?? [PipelineStep.resolve],
    initialStepModels: initialData?.stepModels,
    initialStepThinkingLevels: initialData?.stepThinkingLevels,
    initialPrRepoIds: (initialData?.repositories ?? [])
      .filter((repository) => repository.create_mr && repository.repo_id)
      .map((repository) => repository.repo_id),
  });

  async function submitForm(runImmediately: boolean) {
    if (chosenSteps.size === 0) return;
    const payload = buildIssuePayload({
      title,
      jiraIssueUrl,
      repositories,
      additionalContext,
      chosenSteps,
      prRepoIds,
      stepModels,
      stepThinkingLevels,
      devOpsModel,
      devOpsThinkingLevel,
      workerCount,
      runImmediately,
    });

    try {
      await onSubmit(payload, files);
      setFiles([]);
    } catch (error) {
      void error;
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitForm(true);
  }

  function handleSave(event: MouseEvent) {
    event.preventDefault();
    void submitForm(false);
  }

  function removeJira() {
    setJiraIssueUrl('');
    setShowJira(false);
  }

  const formBody = (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <IssueBasics
        title={title}
        onTitleChange={setTitle}
        description={additionalContext}
        onDescriptionChange={setAdditionalContext}
        tags={tags}
        onSelectTag={selectTag}
        showFiles={showFiles}
        files={files}
        onFilesChange={setFiles}
      />

      <RepositoriesField
        repositories={repositories}
        savedRepos={savedRepos}
        savedReposLoading={savedReposLoading}
        savedReposErrorText={savedReposErrorText}
        onSelectRepo={selectRepository}
        onUpdateBranch={updateBaseBranch}
        onToggleBootstrap={toggleRepositoryBootstrap}
        onRemove={removeRepository}
        onAdd={addRepository}
      />

      <JiraField
        expanded={showJira}
        value={jiraIssueUrl}
        onChange={(url) => setJiraIssueUrl(url)}
        onMakeVisible={() => setShowJira(true)}
        onRemove={removeJira}
      />

      {repositories.length > 0 && (
        <DevopsModelField
          models={models}
          modelsLoading={modelsLoading}
          model={devOpsModel}
          thinking={devOpsThinkingLevel}
          onChangeModel={setDevOpsModel}
          onChangeThinking={setDevOpsThinkingLevel}
        />
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

      <ReportModelField
        models={models}
        modelsLoading={modelsLoading}
        stepModels={stepModels}
        stepThinkingLevels={stepThinkingLevels}
        onChangeModel={updateStepModel}
        onChangeThinking={updateStepThinkingLevel}
      />

      <FormError message={error} />

      <div className="flex flex-col gap-3 sm:flex-row">
        {showRunButton && (
          <button
            type="submit"
            disabled={submitting || chosenSteps.size === 0}
            className="min-h-12 w-full rounded-none border border-[#00FF41] bg-[#003B00] px-5 py-2 text-sm font-medium text-[#00FF41] shadow-[0_0_10px_rgba(0,255,65,0.35)] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 md:w-auto"
          >
            {submitting ? 'Запускаем…' : submitLabel}
          </button>
        )}
        {showSaveButton && (
          <button
            type="button"
            disabled={submitting || chosenSteps.size === 0}
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