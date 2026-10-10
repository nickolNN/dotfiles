import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { insertMany, listByIssue, listByIteration } from '../src/db/issue-files.repo';
import { FakePiRunner } from '../src/pi/runner';

const ENDPOINT = '/issue-resolver/api/v1/issues';

interface MultipartFile {
  name: string;
  content: string;
}

/** Собирает multipart/form-data тело: поле `payload` + повторяющиеся `files`. */
function multipart(
  fields: Record<string, string>,
  files: MultipartFile[],
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----issue-resolver-test-boundary';
  const chunks: Buffer[] = [];
  const push = (value: string | Buffer): void => {
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'));
  };

  for (const [key, value] of Object.entries(fields)) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
    );
  }
  for (const file of files) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    push(file.content);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 1000,
  stepMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor: таймаут ожидания условия');
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function makeEnv(): {
  db: ReturnType<typeof createDb>;
  root: string;
  pi: FakePiRunner;
  app: ReturnType<typeof buildApp>;
  cleanup: () => Promise<void>;
} {
  const db = createDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'issue-resolver-files-'));
  const pi = new FakePiRunner();
  const app = buildApp(db, { pi, workspaceRoot: root });
  return {
    db,
    root,
    pi,
    app,
    cleanup: async () => {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function createIssue(
  app: ReturnType<typeof buildApp>,
  body: object,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: ENDPOINT,
    payload: body,
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

describe('multipart-загрузка файлов', () => {
  it('POST /issues: 2 файла сохранены, в БД и в промпте', async () => {
    const { db, root, pi, app, cleanup } = makeEnv();
    try {
      const { payload, headers } = multipart(
        {
          payload: JSON.stringify({
            title: 'С файлами',
            pipeline_steps: ['resolve'],
          }),
        },
        [
          { name: 'a.txt', content: 'alpha' },
          { name: 'b.txt', content: 'beta' },
        ],
      );

      const response = await app.inject({
        method: 'POST',
        url: ENDPOINT,
        payload,
        headers,
      });
      expect(response.statusCode).toBe(201);
      const issueId = response.json().id as string;

      const files = await listByIssue(db, issueId);
      expect(files.map((file) => file.name).sort()).toEqual(['a.txt', 'b.txt']);
      expect(files.every((file) => file.rel_path.startsWith('attachments/'))).toBe(
        true,
      );
      expect(files.every((file) => file.iteration_id !== null)).toBe(true);
      expect(existsSync(join(root, issueId, 'attachments', 'a.txt'))).toBe(true);

      await waitFor(() => (pi.calls.length > 0 ? pi.calls.length : undefined));
      const prompt = pi.calls[0].prompt;
      expect(prompt).toContain('Uploaded files (already in the working folder):');
      for (const file of files) {
        expect(prompt).toContain(`- ${file.rel_path}`);
      }
    } finally {
      await cleanup();
    }
  });

  it('JSON POST /issues не создаёт файлов, GET files пуст (поведение не изменилось)', async () => {
    const { db, app, cleanup } = makeEnv();
    try {
      const issueId = await createIssue(app, {
        title: 'Без файлов',
        pipeline_steps: ['resolve'],
      });

      expect(await listByIssue(db, issueId)).toEqual([]);

      const response = await app.inject({
        method: 'GET',
        url: `${ENDPOINT}/${issueId}/files`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('POST /issues/:id/iterations: файл в attachments/iteration-2 и в промпте', async () => {
    const { db, root, pi, app, cleanup } = makeEnv();
    try {
      const issueId = await createIssue(app, {
        title: 'Итерации',
        pipeline_steps: ['resolve'],
      });
      // Итерация №1 завершилась (или как минимум запустилась).
      await waitFor(() => (pi.calls.length >= 1 ? true : undefined));

      const { payload, headers } = multipart(
        { payload: JSON.stringify({ context: 'ещё контекст' }) },
        [{ name: 'note.txt', content: 'note' }],
      );
      const response = await app.inject({
        method: 'POST',
        url: `${ENDPOINT}/${issueId}/iterations`,
        payload,
        headers,
      });
      expect(response.statusCode).toBe(201);
      const iteration = response.json();
      expect(iteration.number).toBe(2);

      const files = await listByIteration(db, iteration.id);
      expect(files).toHaveLength(1);
      expect(files[0].rel_path).toBe('attachments/iteration-2/note.txt');
      expect(
        existsSync(join(root, issueId, 'attachments', 'iteration-2', 'note.txt')),
      ).toBe(true);

      await waitFor(() =>
        pi.calls.some((call) =>
          call.prompt.includes('attachments/iteration-2/note.txt'),
        )
          ? true
          : undefined,
      );
    } finally {
      await cleanup();
    }
  });

  it('имя файла с traversal нейтрализуется', async () => {
    const { db, root, app, cleanup } = makeEnv();
    try {
      const { payload, headers } = multipart(
        { payload: JSON.stringify({ title: 'Traversal' }) },
        [{ name: '../../evil.txt', content: 'boom' }],
      );
      const response = await app.inject({
        method: 'POST',
        url: ENDPOINT,
        payload,
        headers,
      });
      expect(response.statusCode).toBe(201);

      const files = await listByIssue(db, response.json().id as string);
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('evil.txt');
      expect(files[0].rel_path).toBe('attachments/evil.txt');
      expect(
        existsSync(join(root, response.json().id as string, 'attachments', 'evil.txt')),
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('multipart без payload и с битым JSON → 400', async () => {
    const { app, cleanup } = makeEnv();
    try {
      const missing = multipart({}, [{ name: 'a.txt', content: 'x' }]);
      const missingResponse = await app.inject({
        method: 'POST',
        url: ENDPOINT,
        payload: missing.payload,
        headers: missing.headers,
      });
      expect(missingResponse.statusCode).toBe(400);

      const broken = multipart({ payload: '{не json' }, []);
      const brokenResponse = await app.inject({
        method: 'POST',
        url: ENDPOINT,
        payload: broken.payload,
        headers: broken.headers,
      });
      expect(brokenResponse.statusCode).toBe(400);
    } finally {
      await cleanup();
    }
  });
});

describe('GET /issues/:id/files и DELETE /files/:fileId', () => {
  it('GET files: 404 для несуществующей задачи', async () => {
    const { app, cleanup } = makeEnv();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `${ENDPOINT}/nope/files`,
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await cleanup();
    }
  });

  it('GET /files/:id/content: 200 + байты + Content-Type/Disposition', async () => {
    const { db, app, cleanup } = makeEnv();
    try {
      const { payload, headers } = multipart(
        { payload: JSON.stringify({ title: 'Контент' }) },
        [{ name: 'note.txt', content: 'hello bytes' }],
      );
      const created = await app.inject({
        method: 'POST',
        url: ENDPOINT,
        payload,
        headers,
      });
      expect(created.statusCode).toBe(201);
      const [file] = await listByIssue(db, created.json().id as string);

      const response = await app.inject({
        method: 'GET',
        url: `/issue-resolver/api/v1/files/${file.id}/content`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('hello bytes');
      expect(response.headers['content-type']).toContain(
        'application/octet-stream',
      );
      expect(response.headers['content-disposition']).toContain(
        'attachment; filename="note.txt"',
      );
      expect(response.headers['content-disposition']).toContain(
        "filename*=UTF-8''note.txt",
      );
    } finally {
      await cleanup();
    }
  });

  it('GET /files/:id/content: 404 для неизвестного id', async () => {
    const { app, cleanup } = makeEnv();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/issue-resolver/api/v1/files/nope/content',
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await cleanup();
    }
  });

  it('GET /files/:id/content: fallback Content-Type + filename* для не-ASCII', async () => {
    const { db, root, app, cleanup } = makeEnv();
    try {
      const issueId = await createIssue(app, { title: 'Non ascii' });
      mkdirSync(join(root, issueId, 'attachments'), { recursive: true });
      writeFileSync(join(root, issueId, 'attachments', 'отчёт.txt'), 'data');
      const [row] = await insertMany(db, [
        {
          issueId,
          name: 'отчёт.txt',
          relPath: 'attachments/отчёт.txt',
          size: 4,
          mimeType: null,
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: `/issue-resolver/api/v1/files/${row.id}/content`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('data');
      expect(response.headers['content-type']).toContain(
        'application/octet-stream',
      );
      const disposition = String(response.headers['content-disposition']);
      expect(disposition).toContain('attachment; filename="');
      expect(disposition).toContain("filename*=UTF-8''");
      expect(disposition).not.toContain('отчёт');
    } finally {
      await cleanup();
    }
  });

  it('GET /files/:id/content: traversal rel_path нейтрализуется (404)', async () => {
    const { db, root, app, cleanup } = makeEnv();
    try {
      const issueId = await createIssue(app, { title: 'Traversal content' });
      // Файл существует, но ВНЕ папки attachments задачи.
      writeFileSync(join(root, 'evil.txt'), 'boom');
      const [row] = await insertMany(db, [
        {
          issueId,
          name: 'evil.txt',
          relPath: '../evil.txt',
          size: 4,
          mimeType: 'text/plain',
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: `/issue-resolver/api/v1/files/${row.id}/content`,
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await cleanup();
    }
  });

  it('DELETE файла удаляет строку и файл с диска; повторно — 404', async () => {
    const { db, root, app, cleanup } = makeEnv();
    try {
      const { payload, headers } = multipart(
        { payload: JSON.stringify({ title: 'Удаление' }) },
        [{ name: 'doc.txt', content: 'doc' }],
      );
      const created = await app.inject({
        method: 'POST',
        url: ENDPOINT,
        payload,
        headers,
      });
      expect(created.statusCode).toBe(201);
      const issueId = created.json().id as string;
      const [file] = await listByIssue(db, issueId);
      const abs = join(root, issueId, file.rel_path);
      expect(existsSync(abs)).toBe(true);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/issue-resolver/api/v1/files/${file.id}`,
      });
      expect(deleted.statusCode).toBe(204);
      expect(await listByIssue(db, issueId)).toEqual([]);
      expect(existsSync(abs)).toBe(false);

      const again = await app.inject({
        method: 'DELETE',
        url: `/issue-resolver/api/v1/files/${file.id}`,
      });
      expect(again.statusCode).toBe(404);
    } finally {
      await cleanup();
    }
  });
});