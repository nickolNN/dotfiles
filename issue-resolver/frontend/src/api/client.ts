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
  RoomAgent,
  SavedRepo,
  SessionCommand,
  SessionControlSnapshot,
  StepRunWithLog,
  Tag,
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
    // тело ответа не JSON или пустое — падаем на общий текст ниже
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

/**
 * Живая валидация URL репозиториев через API хостинг-платформы
 * (`POST /repos/validate`). Бэкенд отвечает `{ results }`.
 *
 * Возвращает по элементу на каждый URL. Если тело ответа неожиданной формы —
 * `[]`, чтобы вызывающий компонент не падал на `.map`/`.find`.
 */
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

/**
 * Живая валидация URL Jira-задачи через Jira API
 * (`POST /issues/validate-jira`). Бэкенд отвечает `{ url, valid, key?, issue?, error? }`.
 */
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

/**
 * Ответ POST/PUT `/repositories`: 2xx — сама сущность; 422 — репозиторий
 * всё равно сохранён (создан/обновлён), но соединение не ok, поэтому
 * возвращаем его из поля `repository`, а не роняем форму.
 */
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

/**
 * Создаёт сохранённый репозиторий: бэкенд валидирует URL и сразу сохраняет
 * метаданные. Недоступный репозиторий → 422 (`{ error, repository }`): он
 * всё равно сохранён со статусом `error` и возвращается.
 */
export async function createRepository(url: string): Promise<SavedRepo> {
  const request: CreateRepoRequest = { url };
  const response = await fetch(`${API_BASE}/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  return readRepositoryResponse(response);
}

/** Меняет URL сохранённого репозитория и перевалидирует его. */
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

/** Удаляет сохранённый репозиторий. */
export async function deleteRepository(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/repositories/${id}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

/** Перепроверяет соединение с сохранённым репозиторием (live). */
export async function validateRepository(id: string): Promise<SavedRepo> {
  const response = await fetch(`${API_BASE}/repositories/${id}/validate`, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as SavedRepo;
}

/** Живой список веток сохранённого репозитория. */
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

/** Запуск сохранённого черновика: создаёт первую итерацию и запускает конвейер. */
export async function startIssue(issueId: string): Promise<{ ok: boolean; iterationId: string }> {
  const response = await fetch(`${API_BASE}/issues/${issueId}/start`, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as { ok: boolean; iterationId: string };
}

/** Редактирование черновика задачи (PUT /issues/:id). */
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

/** Минимальная проверка формы `RoomAgent` (защита от мусора в ответе). */
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

/**
 * Живые агенты комнаты итерации (`GET /iterations/:id/agents`).
 * Best-effort: пока бэкенд-роут ещё не дописан (или сеть/не-2xx/битый JSON)
 * деградируем в `[]` — карточка resolve в room-режиме не должна падать,
 * а `RoomAgentTabs` покажет пустое состояние.
 */
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

/**
 * id уже отвеченных вопросов итерации (персистятся на бэкенде).
 * Best-effort: любой сбой парсинга/сети деградирует в пустой список, чтобы
 * тесты и экран не падали из-за отсутствия нового эндпоинта.
 */
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

/**
 * Отправляет промпт в живую pi-сессию итерации через управляющий роут.
 * `mode` определяет доставку: `steer` прерывает текущий ход, `followUp`
 * встаёт в очередь; без `mode` — новая инструкция. Best-effort: сеть/
 * не-2xx/битый JSON деградируют в `{ok:false}` без исключения.
 */
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
      // Серверный отказ (400/409) — показываем его текст как есть, не выдумывая.
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

/**
 * Снимок управления живой pi-сессией (`state`/`models`/`thinkingLevels`/
 * `commands`). `null` при не-2xx (в т.ч. 409 «no active step session»),
 * сетевом сбое или неожиданной форме ответа — вызывающий просто прячет
 * панель управления.
 */
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

/**
 * Управляющая команда живой pi-сессии (модель, thinking-level, compact,
 * clear_queue и т.п.). Best-effort: не-2xx/сеть → `{ok:false, error}`.
 */
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
        // Бэкенд ждёт `{ command: SessionCommand }` (роут валидирует поле).
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

/** Минимальная проверка формы снимка управления (защита от мусора). */
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

/** Ответ пользователя на интерактивный вопрос расширения pi. */
export interface UiResponsePayload {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/**
 * Отправляет ответ на интерактивный `question`-запрос живой pi-сессии
 * (extension_ui_request → extension_ui_response).
 */
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

/** Перевести черновик в pending (в очередь на выполнение). */
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

/** Обновить черновик (context). */
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

/** Комментарий ревью из MR/PR. */
export interface ReviewCommentEntry {
  repo: string;
  file: string | null;
  line: number | null;
  body: string;
  author: string;
}

/** Получить комментарии ревью из MR/PR. Итерация НЕ создаётся — \n    фронтенд сам решит. */
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

  // 202 — удаление принято и идёт асинхронно (фазы приходят по SSE до
  // `issue_deleted`); 204 — задача удалена синхронно. Оба статуса — успех,
  // поэтому не роняем вызов на «не-JSON» теле ответа.
  if (response.status === 202 || response.status === 204) {
    return;
  }
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

/**
 * Порт dev-сервера задачи (выделяется backend при создании). `null`, если
 * порт ещё/уже не выделен.
 */
export function devServerPortOf(issue: Issue): number | null {
  return issue.dev_server_port ?? null;
}

/** Остановить dev-серверы задачи. Backend идемпотентно гасит процессы. */
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

/**
 * Живая стата контейнера задачи: CPU/память/PIDs. При отсутствии контейнера
 * (local mode) бэкенд отвечает `{ containerName, error: 'container_not_found' }`
 * — полей с метриками тогда нет.
 */
export interface ContainerStats {
  containerName: string;
  cpuPercent?: number;
  memoryUsageBytes?: number;
  memoryLimitBytes?: number;
  pids?: number;
  error?: string;
}

/**
 * Стата контейнера задачи (`GET /issues/:id/container-stats`). Best-effort:
 * сеть/не-2xx/битый JSON деградируют в `null`, чтобы карточка не падала и
 * строка статистики просто не рендерилась.
 */
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

// ── Загрузка файлов (multipart) ─────────────────────────────────────────

/** URL содержимого файла (inline/download, отдаётся бэкендом). */
export function fileContentUrl(fileId: string): string {
  return `${API_BASE}/files/${fileId}/content`;
}

/** URL списка файлов, порождённых агентом в рабочей папке завершённой итерации. */
export function resultFilesUrl(issueId: string): string {
  return `${API_BASE}/issues/${issueId}/result/files`;
}

/** URL содержимого порождённого файла (attachment, отдаётся бэкендом). */
export function resultFileContentUrl(
  issueId: string,
  relPath: string,
): string {
  return `${API_BASE}/issues/${issueId}/result/files/content?path=${encodeURIComponent(relPath)}`;
}

/** URL содержимого порождённого файла для предпросмотра (inline). */
export function resultFilePreviewUrl(
  issueId: string,
  relPath: string,
): string {
  return `${resultFileContentUrl(issueId, relPath)}&inline=1`;
}

/** URL архива (tar.gz) со всеми порождёнными файлами и результатом. */
export function resultFilesArchiveUrl(issueId: string): string {
  return `${API_BASE}/issues/${issueId}/result/files/archive`;
}

/** Список порождённых файлов последней completed-итерации. */
export async function getResultFiles(
  issueId: string,
): Promise<WorkspaceFile[]> {
  const response = await fetch(resultFilesUrl(issueId));
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as WorkspaceFile[];
}

/** MR из `result.json` — артефакта pr-шага (`{ merge_requests: [...] }`). */
export interface ResultMergeRequest {
  repository_url: string;
  url: string;
  title?: string;
  message?: string;
}

/**
 * Разбирает `result.json` в список MR. Битый JSON / иная форма → [] (шапка
 * задачи не должна падать из-за артефакта pr-шага). Экспортировано для тестов.
 */
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

/**
 * MR-ссылки из `result.json` рабочей папки задачи. Единственный источник,
 * переживающий перезагрузку страницы (SSE-событие `stream: 'mr'` не
 * персистится в step_outputs). Best-effort: нет файла/не-2xx/битый JSON → [].
 */
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

/**
 * `FormData` для multipart-создания: поле `payload` — JSON-строка тела,
 * поле `files` повторяется на каждый файл. `Content-Type` не задаём —
 * браузер сам добавит boundary. Экспортировано для тестов.
 */
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

/** Создать задачу с вложениями (multipart). */
export function createIssueWithFiles(
  request: CreateIssueRequest,
  files: File[],
): Promise<Issue> {
  return postMultipart<Issue>(`${API_BASE}/issues`, request, files);
}

/** Создать итерацию с вложениями (multipart). */
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

/**
 * Файлы задачи. Best-effort: сеть/не-2xx/неожиданная форма → `[]`, чтобы
 * карточка не падала из-за нового эндпоинта.
 */
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

/** Удалить вложение по id (204). */
export async function deleteIssueFile(fileId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/files/${fileId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

// ── Теги ────────────────────────────────────────────────────────────────

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
  /** Брошенные комнаты задач (`issue-*` без живых агентов). */
  deleted_rooms: number;
  errors: string[];
}

/** Принудительный запуск report-агента для задачи. */
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

/** Артефакт отчёта на диске: наличие, размер и mtime (ISO-Z без мс). */
export interface ReportArtifactInfo {
  present: boolean;
  bytes: number;
  mtime: string | null;
}

/**
 * Статус отчёта задачи. `status` выводится из последнего прогона (строка
 * `step_runs` вне итерации), а не из наличия файла: прогон, который ничего не
 * создал, — `failed`, даже если exit code был 0.
 */
export interface ReportStatus {
  status: 'idle' | 'running' | 'success' | 'failed';
  /** Идентификатор прогона для `GET /issues/:id/report/run`. */
  runId?: string;
  /** Статус строки прогона в БД (шире, чем `status`: pending/running/...). */
  runStatus?: string;
  /** When the run started / was last updated (ISO). */
  startedAt?: string;
  finishedAt?: string;
  /**
   * Last activity of the run (heartbeat). Present while `running` too: a run
   * whose heartbeat stopped is dead, not busy.
   */
  updatedAt?: string;
  /** Причина падения или пометка "только markdown". */
  feedback?: string;
  /** Что реально легло на диск: обе половины отчёта. */
  artifacts?: { md: ReportArtifactInfo; html: ReportArtifactInfo };
  /** mtime `report.md` — когда отчёт последний раз перезаписан. */
  lastRunAt?: string;
  /**
   * Наблюдённая модель прогона (что реально сообщила сессия), а НЕ запрошенная.
   * Отсутствует после рестарта сервера: значение живёт в памяти процесса и из
   * артефакта не выводится. Во время прогона его тоже нет.
   */
  observedModel?: string;
  /**
   * Механические предупреждения по артефактам: `model id leaked into <file>`,
   * `model-like id leaked into <file>`, `anchored on previous report: <path>`.
   * Слой паттернов считается на чтении, поэтому переживает рестарт.
   */
  warnings?: string[];
}

/** Готовность отчёта задачи (`GET /issues/:id/report/status`). */
export async function getReportStatus(issueId: string): Promise<ReportStatus> {
  const response = await fetch(
    `${API_BASE}/issues/${encodeURIComponent(issueId)}/report/status`,
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as ReportStatus;
}

/**
 * Последний прогон отчёта с логом сессии (`GET /issues/:id/report/run`).
 * Живёт вне итерации, поэтому у шагового маршрута итерации его нет.
 */
export async function getReportRun(issueId: string): Promise<StepRunWithLog> {
  const response = await fetch(
    `${API_BASE}/issues/${encodeURIComponent(issueId)}/report/run`,
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return (await response.json()) as StepRunWithLog;
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