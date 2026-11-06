import { isRecord } from '../guards';

export const API_BASE = '/issue-resolver/api/v1';

type WriteMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE';

interface RequestInput {
  method?: WriteMethod;
  json?: unknown;
  form?: FormData;
  headers?: HeadersInit;
}

interface ErrorDetails {
  error?: string;
  warnings?: string[];
}

export function statusErrorMessage(response: Response): string {
  return `Запрос завершился со статусом ${response.status}`;
}

export async function readErrorDetails(
  response: Response,
): Promise<ErrorDetails> {
  try {
    const data: unknown = await response.json();
    if (!isRecord(data)) return {};
    const record = data;
    return {
      error:
        typeof record.error === 'string' && record.error
          ? record.error
          : undefined,
      warnings: Array.isArray(record.warnings)
        ? record.warnings.filter((item): item is string => typeof item === 'string')
        : undefined,
    };
  } catch {
    return {};
  }
}

export async function readErrorMessage(response: Response): Promise<string> {
  const { error } = await readErrorDetails(response);
  return error ?? statusErrorMessage(response);
}

type QueryValue = string | number | boolean | null | undefined;

export function withQuery(
  url: string,
  params: Record<string, QueryValue>,
): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join('&');
  if (query.length === 0) return url;
  if (url.endsWith('?') || url.endsWith('&')) return `${url}${query}`;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

function jsonHeaders(headers: HeadersInit | undefined): HeadersInit {
  if (headers === undefined) return { 'Content-Type': 'application/json' };
  const merged = new Headers(headers);
  if (!merged.has('Content-Type')) {
    merged.set('Content-Type', 'application/json');
  }
  return merged;
}

function toInit(input: RequestInput): RequestInit | undefined {
  if (input.form !== undefined) {
    return {
      method: input.method ?? 'POST',
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      body: input.form,
    };
  }
  if (input.json !== undefined) {
    return {
      method: input.method ?? 'POST',
      headers: jsonHeaders(input.headers),
      body: JSON.stringify(input.json),
    };
  }
  if (input.headers !== undefined) return { headers: input.headers };
  return input.method === undefined ? undefined : { method: input.method };
}

export function send(
  url: string,
  input: RequestInput = {},
): Promise<Response> {
  const init = toInit(input);
  return init === undefined ? fetch(url) : fetch(url, init);
}

async function requireOk(response: Response): Promise<Response> {
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  return response;
}

export async function requestJson<T>(
  url: string,
  input: RequestInput = {},
): Promise<T> {
  const response = await requireOk(await send(url, input));
  return (await response.json()) as T;
}

export async function requestText(
  url: string,
  input: RequestInput = {},
): Promise<string> {
  const response = await requireOk(await send(url, input));
  return response.text();
}

export async function requestVoid(
  url: string,
  input: RequestInput = {},
): Promise<void> {
  await requireOk(await send(url, input));
}

export async function requestJsonOrNull<T>(
  url: string,
  input: RequestInput = {},
): Promise<T | null> {
  try {
    const response = await send(url, input);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
