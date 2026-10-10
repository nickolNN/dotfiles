import type {
  ControlResult,
  CreateIssueRequest,
  CreateIterationRequest,
  Issue,
  IssueFile,
  Iteration,
  ModelDescriptor,
  PromptMode,
  PromptResult,
  SessionCommand,
  SessionControlSnapshot,
} from '@issue-resolver/shared';
import type { StepRunWithEvents } from './session-events';

const API_BASE = '/issue-resolver/api/v1';

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
      `${API_BASE}/iterations/${iterationId}/prompt`,
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
      `${API_BASE}/iterations/${iterationId}/control`,
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
      `${API_BASE}/iterations/${iterationId}/control`,
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
    `${API_BASE}/iterations/${iterationId}/message`,
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
    `${API_BASE}/iterations/${iterationId}/ui-response`,
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
  const response = await fetch(`${API_BASE}/iterations/${iterationId}/abort`, {
    method: 'POST',
  });

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

export async function deleteIssue(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/issues/${id}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

// ── Загрузка файлов (multipart) ─────────────────────────────────────────

/** URL содержимого файла (inline/download, отдаётся бэкендом). */
export function fileContentUrl(fileId: string): string {
  return `${API_BASE}/files/${fileId}/content`;
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