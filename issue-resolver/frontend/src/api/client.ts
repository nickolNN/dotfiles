import type {
  ControlResult,
  CreateIssueRequest,
  CreateIterationRequest,
  CreateRepoRequest,
  CreateTagRequest,
  Issue,
  IssueFile,
  Iteration,
  JiraValidationResult,
  ModelDescriptor,
  PromptMode,
  PromptResult,
  RepoBranchesResponse,
  RepoValidationResult,
  RetroRun,
  RetroRunWithLog,
  RoomAgent,
  SavedRepo,
  SessionCommand,
  SessionControlSnapshot,
  StepRunWithLog,
  Tag,
  ThinkingLevel,
  UpdateRepoRequest,
  UpdateTagRequest,
  WorkspaceFile,
} from '@issue-resolver/shared';
import type { StepRunWithEvents } from './session-events';

export const API_BASE = '/issue-resolver/api/v1';

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (data && typeof data.error === 'string' && data.error) {
      return data.error;
    }
  } catch {
    // JSON parse failed — use status text
  }
  return `Запрос завершился со статусом ${response.status}`;
}

export async function getIssues(): Promise<Issue[]> {
  const response = await fetch(`${API_BASE}/issues`);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Issue[];
}

export async function getModels(): Promise<ModelDescriptor[]> {
  const response = await fetch(`${API_BASE}/models`);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as ModelDescriptor[];
}

export async function validateRepos(
  urls: string[],
): Promise<RepoValidationResult[]> {
  const response = await fetch(`${API_BASE}/repos/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const data = (await response.json()) as { results?: unknown };
  return Array.isArray(data?.results)
    ? (data.results as RepoValidationResult[])
    : [];
}

export async function validateJiraUrl(
  url: string,
): Promise<JiraValidationResult> {
  const response = await fetch(`${API_BASE}/issues/validate-jira`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as JiraValidationResult;
}

type RepoWriteResponse =
  | SavedRepo
  | { error?: string; repository?: SavedRepo };

async function readRepositoryResponse(response: Response): Promise<SavedRepo> {
  const data = (await response
    .json()
    .catch(() => null)) as RepoWriteResponse | null;
  if (response.ok && data && 'id' in data) {
    return data;
  }
  if (data && 'repository' in data && data.repository) {
    return data.repository;
  }
  const message =
    data && 'error' in data && data.error
      ? data.error
      : `Запрос завершился со статусом ${response.status}`;
  throw new Error(message);
}

export async function getRepositories(): Promise<SavedRepo[]> {
  const response = await fetch(`${API_BASE}/repositories`);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as SavedRepo[];
}

export async function createRepository(url: string): Promise<SavedRepo> {
  const request: CreateRepoRequest = { url };
  const response = await fetch(`${API_BASE}/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  return readRepositoryResponse(response);
}

export async function updateRepository(
  id: string,
  url: string,
): Promise<SavedRepo> {
  const request: UpdateRepoRequest = { url };
  const response = await fetch(`${API_BASE}/repositories/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  return readRepositoryResponse(response);
}

export async function deleteRepository(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/repositories/${id}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

export async function validateRepository(id: string): Promise<SavedRepo> {
  const response = await fetch(`${API_BASE}/repositories/${id}/validate`, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as SavedRepo;
}

export async function getRepositoryBranches(id: string): Promise<string[]> {
  const response = await fetch(`${API_BASE}/repositories/${id}/branches`);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const data = (await response.json()) as RepoBranchesResponse;
  return Array.isArray(data?.branches) ? data.branches : [];
}

export async function createIssue(request: CreateIssueRequest): Promise<Issue> {
  const response = await fetch(`${API_BASE}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Issue;
}

export async function startIssue(issueId: string): Promise<{ ok: boolean; iterationId: string }> {
  const response = await fetch(`${API_BASE}/issues/${issueId}/start`, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as { ok: boolean; iterationId: string };
}

export async function updateIssue(
  id: string,
  request: Partial<Pick<Issue, 'title' | 'description' | 'desired_result' | 'jira_issue_url' | 'pipeline_steps' | 'step_models' | 'thinking_level' | 'step_thinking_levels' | 'tag_id' | 'devops_model' | 'devops_thinking_level'> & { worker_count?: number | null; repositories?: Array<{ repo_id?: string; repository_url?: string; base_branch?: string; create_mr?: boolean; bootstrap_enabled?: boolean }> }>,
): Promise<Issue> {
  const response = await fetch(`${API_BASE}/issues/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Issue;
}

export async function getIssue(id: string): Promise<Issue> {
  const response = await fetch(`${API_BASE}/issues/${id}`);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Issue;
}

export async function getIterations(issueId: string): Promise<Iteration[]> {
  const response = await fetch(`${API_BASE}/issues/${issueId}/iterations`);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Iteration[];
}

export async function getStepRuns(
  iterationId: string,
): Promise<StepRunWithEvents[]> {
  const response = await fetch(`${API_BASE}/iterations/${iterationId}/step-runs`);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as StepRunWithEvents[];
}

function isRoomAgent(value: unknown): value is RoomAgent {
  if (!value || typeof value !== 'object') return false;
  const agent = value as Partial<RoomAgent>;
  return (
    typeof agent.id === 'string' &&
    (agent.role === 'worker' || agent.role === 'coordinator') &&
    typeof agent.label === 'string' &&
    (agent.status === 'running' ||
      agent.status === 'finished' ||
      agent.status === 'aborted' ||
      agent.status === 'failed')
  );
}

export async function getRoomAgents(
  iterationId: string,
): Promise<RoomAgent[]> {
  try {
    const response = await fetch(
      `${API_BASE}/iterations/${iterationId}/agents`,
    );
    if (!response.ok) return [];

    const data: unknown = await response.json();
    return Array.isArray(data) ? data.filter(isRoomAgent) : [];
  } catch {
    return [];
  }
}

export async function getQuestionAnswers(
  iterationId: string,
): Promise<string[]> {
  try {
    const response = await fetch(
      `${API_BASE}/iterations/${iterationId}/question-answers`,
    );
    if (!response.ok) return [];

    const data: unknown = await response.json();
    let raw: unknown = data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      raw = (data as { answered_ids?: unknown }).answered_ids;
    }

    return Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function promptIteration(
  iterationId: string,
  message: string,
  mode?: PromptMode,
): Promise<PromptResult> {
  try {
    const response = await fetch(
      `${API_BASE}/iterations/${encodeURIComponent(iterationId)}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode ? { message, mode } : { message }),
      },
    );
    if (!response.ok) {
      return {
        ok: false,
        disposition: 'started',
        error: await readErrorMessage(response),
      };
    }

    const data = (await response.json()) as {
      ok?: unknown;
      disposition?: unknown;
      error?: unknown;
    };
    const disposition =
      data?.disposition === 'queued' || data?.disposition === 'handled'
        ? data.disposition
        : 'started';
    const ok = data?.ok === false ? false : true;
    const error =
      typeof data?.error === 'string' && data.error.length > 0
        ? data.error
        : undefined;
    return error !== undefined
      ? { ok, disposition, error }
      : { ok, disposition };
  } catch {
    return { ok: false, disposition: 'started' };
  }
}

export async function getIterationControl(
  iterationId: string,
): Promise<SessionControlSnapshot | null> {
  try {
    const response = await fetch(
      `${API_BASE}/iterations/${encodeURIComponent(iterationId)}/control`,
    );
    if (!response.ok) return null;

    const data = (await response.json()) as unknown;
    return isControlSnapshot(data) ? data : null;
  } catch {
    return null;
  }
}

export async function sendIterationCommand(
  iterationId: string,
  command: SessionCommand,
): Promise<ControlResult> {
  try {
    const response = await fetch(
      `${API_BASE}/iterations/${encodeURIComponent(iterationId)}/control`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      },
    );
    if (!response.ok) {
      return { ok: false, error: await readErrorMessage(response) };
    }

    const data = (await response.json()) as unknown;
    if (data && typeof data === 'object') {
      const record = data as { ok?: unknown; data?: unknown; error?: unknown };
      return {
        ok: record.ok === undefined ? true : record.ok === true,
        data: record.data,
        error: typeof record.error === 'string' ? record.error : undefined,
      };
    }
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isControlSnapshot(value: unknown): value is SessionControlSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<SessionControlSnapshot>;
  if (!snapshot.state || typeof snapshot.state !== 'object') return false;
  return (
    Array.isArray(snapshot.models) &&
    Array.isArray(snapshot.thinkingLevels) &&
    Array.isArray(snapshot.commands)
  );
}

export async function sendIterationMessage(
  iterationId: string,
  message: string,
): Promise<{ ok: boolean }> {
  const response = await fetch(
    `${API_BASE}/iterations/${encodeURIComponent(iterationId)}/message`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as { ok: boolean };
}

export interface UiResponsePayload {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export async function sendUiResponse(
  iterationId: string,
  payload: UiResponsePayload,
): Promise<{ ok: boolean }> {
  const response = await fetch(
    `${API_BASE}/iterations/${encodeURIComponent(iterationId)}/ui-response`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as { ok: boolean };
}

export async function abortIteration(iterationId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/iterations/${encodeURIComponent(iterationId)}/abort`,
    {
      method: 'POST',
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

export async function createIteration(
  issueId: string,
  request: CreateIterationRequest,
): Promise<Iteration> {
  const response = await fetch(`${API_BASE}/issues/${issueId}/iterations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Iteration;
}

export async function repeatIteration(
  iterationId: string,
): Promise<Iteration> {
  const response = await fetch(`${API_BASE}/iterations/${iterationId}/repeat`, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Iteration;
}

export async function queueIteration(
  iterationId: string,
): Promise<Iteration> {
  const response = await fetch(
    `${API_BASE}/iterations/${iterationId}/queue`,
    { method: 'POST' },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Iteration;
}

export async function updateIteration(
  iterationId: string,
  request: { context: string },
): Promise<Iteration> {
  const response = await fetch(`${API_BASE}/iterations/${iterationId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Iteration;
}

export interface ReviewCommentEntry {
  repo: string;
  file: string | null;
  line: number | null;
  body: string;
  author: string;
}

export async function fetchReviewComments(
  iterationId: string,
): Promise<{ comments: ReviewCommentEntry[]; errors?: string[] }> {
  const response = await fetch(
    `${API_BASE}/iterations/${iterationId}/fetch-review-comments`,
    { method: 'POST' },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as {
    comments: ReviewCommentEntry[];
    errors?: string[];
  };
}

export async function deleteIssue(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/issues/${id}`, {
    method: 'DELETE',
  });

  if (response.status === 202 || response.status === 204) {
    return;
  }
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

export function devServerPortOf(issue: Issue): number | null {
  return issue.dev_server_port ?? null;
}

export async function stopDevServers(
  issueId: string,
): Promise<{ ok: boolean }> {
  const response = await fetch(
    `${API_BASE}/issues/${encodeURIComponent(issueId)}/stop-dev-servers`,
    { method: 'POST' },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as { ok: boolean };
}

export interface ContainerStats {
  containerName: string;
  cpuPercent?: number;
  memoryUsageBytes?: number;
  memoryLimitBytes?: number;
  pids?: number;
  error?: string;
}

export async function getContainerStats(
  issueId: string,
): Promise<ContainerStats | null> {
  try {
    const response = await fetch(
      `${API_BASE}/issues/${encodeURIComponent(issueId)}/container-stats`,
    );
    if (!response.ok) return null;
    return (await response.json()) as ContainerStats;
  } catch {
    return null;
  }
}

export function fileContentUrl(fileId: string): string {
  return `${API_BASE}/files/${fileId}/content`;
}

export function resultFilesUrl(issueId: string): string {
  return `${API_BASE}/issues/${issueId}/result/files`;
}

export function resultFileContentUrl(
  issueId: string,
  relPath: string,
): string {
  return `${API_BASE}/issues/${issueId}/result/files/content?path=${encodeURIComponent(relPath)}`;
}

export function resultFilePreviewUrl(
  issueId: string,
  relPath: string,
): string {
  return `${resultFileContentUrl(issueId, relPath)}&inline=1`;
}

export function resultFilesArchiveUrl(issueId: string): string {
  return `${API_BASE}/issues/${issueId}/result/files/archive`;
}

export async function getResultFiles(
  issueId: string,
): Promise<WorkspaceFile[]> {
  const response = await fetch(resultFilesUrl(issueId));
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as WorkspaceFile[];
}

export interface ResultMergeRequest {
  repository_url: string;
  url: string;
  title?: string;
  message?: string;
}

export function parseResultMergeRequests(
  text: string,
): ResultMergeRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (parsed as { merge_requests?: unknown } | null)?.merge_requests;
  if (!Array.isArray(list)) return [];

  return list.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!url) return [];
    return [
      {
        repository_url:
          typeof record.repository_url === 'string'
            ? record.repository_url
            : '',
        url,
        ...(typeof record.title === 'string' ? { title: record.title } : {}),
        ...(typeof record.message === 'string'
          ? { message: record.message }
          : {}),
      },
    ];
  });
}

export async function getResultMergeRequests(
  issueId: string,
): Promise<ResultMergeRequest[]> {
  try {
    const url = resultFileContentUrl(issueId, 'result.json');
    const response = await fetch(url);
    if (!response.ok) return [];
    return parseResultMergeRequests(await response.text());
  } catch {
    return [];
  }
}

export function buildUploadFormData(
  request: CreateIssueRequest | CreateIterationRequest,
  files: File[],
): FormData {
  const form = new FormData();
  form.append('payload', JSON.stringify(request));
  for (const file of files) {
    form.append('files', file, file.name);
  }
  return form;
}

async function postMultipart<T>(
  url: string,
  request: CreateIssueRequest | CreateIterationRequest,
  files: File[],
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    body: buildUploadFormData(request, files),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as T;
}

export function createIssueWithFiles(
  request: CreateIssueRequest,
  files: File[],
): Promise<Issue> {
  return postMultipart<Issue>(`${API_BASE}/issues`, request, files);
}

export function createIterationWithFiles(
  issueId: string,
  request: CreateIterationRequest,
  files: File[],
): Promise<Iteration> {
  return postMultipart<Iteration>(
    `${API_BASE}/issues/${issueId}/iterations`,
    request,
    files,
  );
}

function isIssueFile(value: unknown): value is IssueFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Partial<IssueFile>;
  return (
    typeof file.id === 'string' &&
    typeof file.issue_id === 'string' &&
    typeof file.name === 'string'
  );
}

export async function getIssueFiles(issueId: string): Promise<IssueFile[]> {
  try {
    const response = await fetch(`${API_BASE}/issues/${issueId}/files`);
    if (!response.ok) return [];

    const data: unknown = await response.json();
    return Array.isArray(data) ? data.filter(isIssueFile) : [];
  } catch {
    return [];
  }
}

export async function deleteIssueFile(fileId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/files/${fileId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

export async function getTags(): Promise<Tag[]> {
  const response = await fetch(`${API_BASE}/tags`);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Tag[];
}

export async function getTag(id: string): Promise<Tag> {
  const response = await fetch(`${API_BASE}/tags/${id}`);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Tag;
}

export async function createTag(request: CreateTagRequest): Promise<Tag> {
  const response = await fetch(`${API_BASE}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Tag;
}

export async function updateTag(
  id: string,
  request: UpdateTagRequest,
): Promise<Tag> {
  const response = await fetch(`${API_BASE}/tags/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as Tag;
}

export async function deleteTag(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/tags/${id}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

export async function getHostname(): Promise<string> {
  try {
    const response = await fetch(`${API_BASE}/settings/hostname`);
    if (!response.ok) return '';
    const data = (await response.json()) as { hostname?: string };
    return data?.hostname ?? '';
  } catch {
    return '';
  }
}

export async function setHostname(hostname: string): Promise<void> {
  const response = await fetch(`${API_BASE}/settings/hostname`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostname }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

export interface CleanupResult {
  orphaned_workspaces: number;
  killed_processes: number;
  deleted_dirs: number;
  deleted_rooms: number;
  errors: string[];
}

export async function runReportAgent(issueId: string, model?: string, thinkingLevel?: string): Promise<{ ok: boolean; reportRunId: string }> {
  const params = new URLSearchParams();
  if (model) params.set('model', model);
  if (thinkingLevel) params.set('thinking', thinkingLevel);
  const qs = params.toString();
  const url = `${API_BASE}/issues/${encodeURIComponent(issueId)}/report${qs ? `?${qs}` : ''}`;
  const response = await fetch(url, { method: 'POST' });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as { ok: boolean; reportRunId: string };
}

export interface ReportArtifactInfo {
  present: boolean;
  bytes: number;
  mtime: string | null;
}

export interface ReportStatus {
  status: 'idle' | 'running' | 'success' | 'failed';
  runId?: string;
  runStatus?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt?: string;
  feedback?: string;
  artifacts?: { md: ReportArtifactInfo; html: ReportArtifactInfo };
  lastRunAt?: string;
  observedModel?: string;
  warnings?: string[];
}

const REPORT_STATUSES = new Set(['idle', 'running', 'success', 'failed']);

export async function getReportStatus(issueId: string): Promise<ReportStatus> {
  const response = await fetch(
    `${API_BASE}/issues/${encodeURIComponent(issueId)}/report/status`,
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const payload = (await response.json()) as Partial<ReportStatus> | null;
  const status = payload?.status;
  if (typeof status !== 'string' || !REPORT_STATUSES.has(status)) {
    throw new Error('некорректный ответ статуса отчёта');
  }
  const artifacts = payload?.artifacts as Record<string, unknown> | null;
  if (typeof artifacts !== 'object' || artifacts === null) {
    throw new Error('некорректный ответ статуса отчёта');
  }
  return payload as ReportStatus;
}

export async function reembedReport(issueId: string): Promise<{
  warnings: string[];
  embed: string;
}> {
  const response = await fetch(
    `${API_BASE}/issues/${encodeURIComponent(issueId)}/report/reembed`,
    { method: 'POST' },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      warnings?: string[];
    } | null;
    const reason = payload?.error ?? (await readErrorMessage(response));
    const warnings = payload?.warnings ?? [];
    throw new Error(
      warnings.length > 0 ? `${reason}: ${warnings.join('; ')}` : reason,
    );
  }
  return (await response.json()) as { warnings: string[]; embed: string };
}

export async function getReportRun(issueId: string): Promise<StepRunWithLog> {
  const response = await fetch(
    `${API_BASE}/issues/${encodeURIComponent(issueId)}/report/run`,
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const payload = (await response.json()) as Partial<StepRunWithLog> | null;
  if (typeof payload?.id !== 'string' || payload?.step !== 'report') {
    throw new Error('некорректный ответ прогона отчёта');
  }
  return payload as StepRunWithLog;
}

export async function runDevopsAgent(issueId: string): Promise<{ ok: boolean }> {
  const url = `${API_BASE}/issues/${encodeURIComponent(issueId)}/devops`;
  const response = await fetch(url, { method: 'POST' });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as { ok: boolean };
}

export interface DevopsStatus {
  status: 'idle' | 'running' | 'success' | 'failed';
  runId?: string;
  runStatus?: string;
  startedAt?: string;
  finishedAt?: string;
  feedback?: string;
}

export async function getDevopsStatus(issueId: string): Promise<DevopsStatus> {
  const response = await fetch(
    `${API_BASE}/issues/${encodeURIComponent(issueId)}/devops/status`,
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as DevopsStatus;
}

export async function getDevopsRun(issueId: string): Promise<StepRunWithLog> {
  const response = await fetch(
    `${API_BASE}/issues/${encodeURIComponent(issueId)}/devops/run`,
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const payload = (await response.json()) as Partial<StepRunWithLog> | null;
  if (typeof payload?.id !== 'string' || payload?.step !== 'devops') {
    throw new Error('некорректный ответ прогона devops');
  }
  return payload as StepRunWithLog;
}

export async function cleanupOrphans(): Promise<CleanupResult> {
  const response = await fetch(`${API_BASE}/admin/cleanup-orphans`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as CleanupResult;
}

export interface StartRetroRunInput {
  model?: string;
  thinking_level?: ThinkingLevel;
  session_limit?: number;
  instructions?: string;
}

const RETRO_PATH = `${API_BASE}/settings/retro`;

export async function startRetroRun(
  input: StartRetroRunInput = {},
): Promise<RetroRun> {
  const response = await fetch(RETRO_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as RetroRun;
}

export async function getRetroRuns(): Promise<RetroRun[]> {
  const response = await fetch(RETRO_PATH);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  const payload = (await response.json()) as { runs?: RetroRun[] } | null;
  return Array.isArray(payload?.runs) ? payload.runs : [];
}

export async function getRetroRun(id: string): Promise<RetroRunWithLog> {
  const response = await fetch(`${RETRO_PATH}/${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as RetroRunWithLog;
}

export async function abortRetroRun(id: string): Promise<void> {
  const response = await fetch(
    `${RETRO_PATH}/${encodeURIComponent(id)}/abort`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}