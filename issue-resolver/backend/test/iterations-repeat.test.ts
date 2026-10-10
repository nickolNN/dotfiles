import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import {
  insertMany,
  listByIssue,
  listByIteration,
} from '../src/db/issue-files.repo';
import { FakePiRunner } from '../src/pi/runner';

const ISSUES = '/issue-resolver/api/v1/issues';
const ITERATIONS = '/issue-resolver/api/v1/iterations';

interface MultipartFile {
  name: string;
  content: string;
}

/** multipart/form-data: поле `payload` + повторяющиеся `files`. */
function multipart(
  fields: Record<string, string>,
  files: MultipartFile[],
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----issue-resolver-repeat-boundary';
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
  const root = mkdtempSync(join(tmpdir(), 'issue-resolver-repeat-'));
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
    url: ISSUES,
    payload: body,
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

describe('POST /iterations/:id/repeat', () => {
  it('неизвестная итерация → 404 { error: iteration not found }', async () => {
    const { app, cleanup } = makeEnv();
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${ITERATIONS}/${randomUUID()}/repeat`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'iteration not found' });
    } finally {
      await cleanup();
    }
  });

  it('копирует параметры/запрос, берёт следующий number и отдаёт полный Iteration (201)', async () => {
    const { pi, app, cleanup } = makeEnv();
    try {
      const issueId = await createIssue(app, {
        title: 'Повтор',
        pipeline_steps: ['resolve'],
      });
      await waitFor(() => (pi.calls.length >= 1 ? true : undefined));

      const created = await app.inject({
        method: 'POST',
        url: `${ISSUES}/${issueId}/iterations`,
        payload: {
          context: 'исходный запрос',
          review_context: 'ревью-контекст',
          is_review_need: true,
          steps: ['resolve', 'review', 'test'],
          model: 'gpt-x',
          step_models: { resolve: 'gpt-y' },
          thinking_level: 'high',
          step_thinking_levels: { resolve: 'off' },
        },
      });
      expect(created.statusCode).toBe(201);
      const source = created.json();
      expect(source.number).toBe(2);

      const repeat = await app.inject({
        method: 'POST',
        url: `${ITERATIONS}/${source.id}/repeat`,
      });

      expect(repeat.statusCode).toBe(201);
      const copy = repeat.json();

      expect(copy.id).not.toBe(source.id);
      expect(copy.issue_id).toBe(issueId);
      expect(copy.number).toBe(3);
      expect(copy.status).toBe('pending');
      // Параметры/запрос копируются ВЕРБАТИМ (шаги не пересчитываются).
      expect(copy.context).toBe(source.context);
      expect(copy.review_context).toBe('ревью-контекст');
      expect(copy.is_review_need).toBe(true);
      expect(copy.steps).toEqual(['resolve', 'review', 'test']);
      expect(copy.model).toBe('gpt-x');
      expect(copy.step_models).toEqual({ resolve: 'gpt-y' });
      expect(copy.thinking_level).toBe('high');
      expect(copy.step_thinking_levels).toEqual({ resolve: 'off' });

      // Полная форма Iteration — все поля присутствуют.
      expect(Object.keys(copy).sort()).toEqual(
        [
          'context',
          'created_at',
          'id',
          'is_review_need',
          'issue_id',
          'model',
          'number',
          'review_context',
          'status',
          'step_models',
          'step_thinking_levels',
          'steps',
          'thinking_level',
          'updated_at',
        ].sort(),
      );

      const list = (
        await app.inject({ method: 'GET', url: `${ISSUES}/${issueId}/iterations` })
      ).json();
      expect(list.map((item: { number: number }) => item.number)).toEqual([
        1, 2, 3,
      ]);
    } finally {
      await cleanup();
    }
  });

  it('копирует вложения итерации, не дублирует файлы уровня задачи', async () => {
    const { db, pi, app, cleanup } = makeEnv();
    try {
      const issueId = await createIssue(app, {
        title: 'Вложения',
        pipeline_steps: ['resolve'],
      });
      await waitFor(() => (pi.calls.length >= 1 ? true : undefined));

      // Итерация #2 с вложением уровня итерации.
      const { payload, headers } = multipart(
        {
          payload: JSON.stringify({
            context: 'с вложением',
            steps: ['resolve'],
          }),
        },
        [{ name: 'note.txt', content: 'note' }],
      );
      const created = await app.inject({
        method: 'POST',
        url: `${ISSUES}/${issueId}/iterations`,
        payload,
        headers,
      });
      expect(created.statusCode).toBe(201);
      const source = created.json();

      const sourceFiles = await listByIteration(db, source.id as string);
      expect(sourceFiles).toHaveLength(1);
      expect(sourceFiles[0].rel_path).toBe('attachments/iteration-2/note.txt');

      // Файл уровня задачи (iteration_id IS NULL) — дублировать нельзя.
      await insertMany(db, [
        {
          issueId,
          name: 'shared.txt',
          relPath: 'attachments/shared.txt',
          size: 3,
          mimeType: 'text/plain',
        },
      ]);

      const repeat = await app.inject({
        method: 'POST',
        url: `${ITERATIONS}/${source.id}/repeat`,
      });
      expect(repeat.statusCode).toBe(201);
      const copy = repeat.json();

      const copied = await listByIteration(db, copy.id as string);
      expect(copied).toHaveLength(1);
      expect(copied[0].rel_path).toBe(sourceFiles[0].rel_path);
      expect(copied[0].iteration_id).toBe(copy.id);
      expect(copied[0].id).not.toBe(sourceFiles[0].id);
      expect(copied[0].name).toBe('note.txt');
      expect(copied[0].size).toBe(sourceFiles[0].size);
      expect(copied[0].mime_type).toBe(sourceFiles[0].mime_type);

      // Исходное вложение не пропало; файл задачи остался ровно один.
      expect(await listByIteration(db, source.id as string)).toHaveLength(1);
      const taskLevel = (await listByIssue(db, issueId)).filter(
        (file) => file.iteration_id === null,
      );
      expect(taskLevel).toHaveLength(1);
      expect(taskLevel[0].rel_path).toBe('attachments/shared.txt');
    } finally {
      await cleanup();
    }
  });
});