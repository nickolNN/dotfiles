import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateIssueRequest, CreateIterationRequest } from '@issue-resolver/shared';
import {
  buildUploadFormData,
  createIssue,
  createIssueWithFiles,
  createIterationWithFiles,
  deleteIssueFile,
  fileContentUrl,
  getIssueFiles,
} from './client';

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

function file(name: string, content = 'x', type = 'text/plain'): File {
  return new File([content], name, { type });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api/client — multipart-загрузка файлов', () => {
  it('buildUploadFormData: payload — JSON-строка, files повторяются по порядку', () => {
    const request: CreateIssueRequest = { title: 'T', repositories: [] };
    const form = buildUploadFormData(request, [
      file('a.txt', 'aaa'),
      file('b.bin', 'bbbb'),
    ]);

    expect(form.get('payload')).toBe(JSON.stringify(request));
    const files = form.getAll('files');
    expect(files).toHaveLength(2);
    expect((files[0] as File).name).toBe('a.txt');
    expect((files[1] as File).name).toBe('b.bin');
  });

  it('createIssueWithFiles: POST /issues с FormData и без ручного Content-Type', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ id: 'issue-1' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request: CreateIssueRequest = { title: 'Fix' };
    const issue = await createIssueWithFiles(request, [file('log.txt')]);

    expect(issue).toEqual({ id: 'issue-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/issue-resolver/api/v1/issues');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get('payload')).toBe(JSON.stringify(request));
    expect(init?.headers).toBeUndefined();
  });

  it('createIterationWithFiles: POST /issues/:id/iterations', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ id: 'iter-1' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request: CreateIterationRequest = { context: 'retry' };
    await createIterationWithFiles('issue-1', request, [file('a'), file('b')]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      '/issue-resolver/api/v1/issues/issue-1/iterations',
    );
    expect((init?.body as FormData).getAll('files')).toHaveLength(2);
    expect(init?.headers).toBeUndefined();
  });

  it('createIssue (JSON-путь) по-прежнему шлёт application/json', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ id: 'issue-1' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createIssue({ title: 'Fix' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(typeof init?.body).toBe('string');
  });

  it('getIssueFiles: валидный массив фильтруется, мусор — деградирует в []', async () => {
    const good = {
      id: 'f1',
      issue_id: 'issue-1',
      iteration_id: null,
      name: 'a.txt',
      rel_path: 'attachments/a.txt',
      size: 3,
      mime_type: 'text/plain',
      created_at: '2026-10-10T00:00:00.000Z',
    };
    const fetchMock = vi.fn((_input: RequestInfo | URL) =>
      Promise.resolve(jsonResponse([good, { nope: true }])),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await getIssueFiles('issue-1')).toEqual([good]);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/issue-resolver/api/v1/issues/issue-1/files');
  });

  it('getIssueFiles: не-2xx / не массив / сбой сети → []', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({}, { ok: false, status: 500 }))),
    );
    expect(await getIssueFiles('issue-1')).toEqual([]);

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ files: [] }))),
    );
    expect(await getIssueFiles('issue-1')).toEqual([]);

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );
    expect(await getIssueFiles('issue-1')).toEqual([]);
  });

  it('deleteIssueFile: DELETE /files/:id, не-2xx бросает', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(jsonResponse(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await deleteIssueFile('f1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/issue-resolver/api/v1/files/f1');
    expect(init?.method).toBe('DELETE');

    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          jsonResponse({ error: 'file not found' }, { ok: false, status: 404 }),
        ),
      ),
    );
    await expect(deleteIssueFile('f1')).rejects.toThrow('file not found');
  });

  it('fileContentUrl указывает на /files/:id/content', () => {
    expect(fileContentUrl('f1')).toBe(
      '/issue-resolver/api/v1/files/f1/content',
    );
  });
});