import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { issues, iterations, issueFiles } from '../src/db/schema';
import { FakePiRunner } from '../src/pi/runner';

const ROUTE_PATH = '/issue-resolver/api/v1/issues';

/** Собирает multipart/form-data тело: поле `payload` + повторяющиеся `files`. */
interface MultipartFile {
  name: string;
  content: string;
}
function multipart(
  fields: Record<string, string>,
  files: MultipartFile[],
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----draft-test-boundary';
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
  db: Db;
  root: string;
  pi: FakePiRunner;
  app: ReturnType<typeof buildApp>;
  cleanup: () => Promise<void>;
} {
  const db = createDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'issue-resolver-draft-'));
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

const CREATION_PAYLOAD = {
  title: 'Задача-черновик',
  repositories: [
    { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
  ],
};

function countIterations(db: Db, issueId: string): number {
  return db
    .select()
    .from(iterations)
    .where(eq(iterations.issue_id, issueId))
    .all().length;
}

function getIssue(db: Db, issueId: string) {
  return db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .all()[0];
}

// =========================================================================
// POST /issues — создание черновика
// =========================================================================

describe('POST /issues — создание черновика (run_immediately: false)', () => {
  it('создаёт задачу со статусом draft и без итераций', async () => {
    const { app, db, cleanup } = makeEnv();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { ...CREATION_PAYLOAD, run_immediately: false },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('draft');
    expect(body.id).toBeDefined();

    // В БД нет итераций.
    expect(countIterations(db, body.id)).toBe(0);

    // GET возвращает draft.
    const getResp = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${body.id}`,
    });
    expect(getResp.json().status).toBe('draft');

    await cleanup();
  });

  it('черновик появляется в списке со статусом draft', async () => {
    const { app, cleanup } = makeEnv();

    const createResp = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { ...CREATION_PAYLOAD, run_immediately: false },
    });
    const draftId = createResp.json().id;

    const listResp = await app.inject({ method: 'GET', url: ROUTE_PATH });
    expect(listResp.statusCode).toBe(200);
    const list = listResp.json();
    const draft = list.find((i: { id: string }) => i.id === draftId);
    expect(draft).toBeDefined();
    expect(draft.status).toBe('draft');

    await cleanup();
  });

  it('сохраняет все поля черновика: title, desired_result, pipeline_steps, repositories', async () => {
    const { app, cleanup } = makeEnv();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: {
        title: 'Черновик с деталями',
        desired_result: 'html',
        repositories: [
          { repository_url: 'https://github.com/acme/app.git', base_branch: 'dev' },
        ],
        pipeline_steps: ['refine', 'resolve', 'review'],
        run_immediately: false,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('draft');
    expect(body.title).toBe('Черновик с деталями');
    expect(body.desired_result).toBe('html');
    expect(body.pipeline_steps).toEqual(['refine', 'resolve', 'review']);
    expect(body.repositories).toHaveLength(1);
    expect(body.repositories[0].branch_name).toBe('dev');

    await cleanup();
  });

  it('сохраняет файлы черновика в workspace и записывает в БД с iteration_id=null', async () => {
    const { app, db, root, cleanup } = makeEnv();

    const { payload, headers } = multipart(
      {
        payload: JSON.stringify({
          title: 'Черновик с файлами',
          run_immediately: false,
        }),
      },
      [
        { name: 'readme.md', content: '# Hello' },
        { name: 'config.json', content: '{"key":"value"}' },
      ],
    );

    const response = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload,
      headers,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('draft');

    // Файлы на диске.
    expect(existsSync(join(root, body.id, 'attachments', 'readme.md'))).toBe(true);
    expect(existsSync(join(root, body.id, 'attachments', 'config.json'))).toBe(true);

    // В БД: iteration_id = null.
    const fileRows = db
      .select()
      .from(issueFiles)
      .where(eq(issueFiles.issue_id, body.id))
      .all();
    expect(fileRows).toHaveLength(2);
    for (const row of fileRows) {
      expect(row.iteration_id).toBeNull();
    }

    await cleanup();
  });

  it('run_immediately по умолчанию true (обратная совместимость)', async () => {
    const { app, db, cleanup } = makeEnv();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: CREATION_PAYLOAD, // без run_immediately
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('pending');

    // Итерация создана.
    expect(countIterations(db, body.id)).toBe(1);

    await cleanup();
  });

  it('run_immediately: true создаёт обычную задачу', async () => {
    const { app, db, cleanup } = makeEnv();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { ...CREATION_PAYLOAD, run_immediately: true },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('pending');
    expect(countIterations(db, body.id)).toBe(1);

    await cleanup();
  });

  it('черновик создаётся даже без репозиториев', async () => {
    const { app, cleanup } = makeEnv();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: {
        title: 'Черновик без репозиториев',
        run_immediately: false,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe('draft');

    await cleanup();
  });

  it('черновик не запускает пайплайн (FakePiRunner без вызовов)', async () => {
    const { app, pi, cleanup } = makeEnv();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { ...CREATION_PAYLOAD, run_immediately: false },
    });
    expect(response.statusCode).toBe(201);

    // FakePiRunner не должен был использоваться для запуска агентов.
    // В in-memory режиме pi не вызывается без подготовленного workspace —
    // для черновика пайплайн не стартует.
    expect(pi.calls).toStrictEqual([]);

    await cleanup();
  });
});

// =========================================================================
// POST /issues/:id/start — запуск черновика
// =========================================================================

describe('POST /issues/:id/start — запуск черновика', () => {
  it('переводит draft в running/preparing и создаёт iteration #1', async () => {
    const { app, db, cleanup } = makeEnv();

    // Создаём черновик.
    const createResp = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { ...CREATION_PAYLOAD, run_immediately: false },
    });
    const draftId = createResp.json().id;

    // Запускаем.
    const startResp = await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${draftId}/start`,
    });
    expect(startResp.statusCode).toBe(200);
    const startBody = startResp.json();
    expect(startBody.ok).toBe(true);
    expect(startBody.iterationId).toBeDefined();

    // В БД: итерация создана, статус задачи != draft.
    const updated = getIssue(db, draftId);
    expect(updated).toBeDefined();
    expect(updated.status).not.toBe('draft');
    expect(countIterations(db, draftId)).toBe(1);

    // GET возвращает не draft.
    const getResp = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${draftId}`,
    });
    expect(getResp.json().status).not.toBe('draft');

    await cleanup();
  });

  it('запуск не-черновика → 409 Conflict', async () => {
    const { app, cleanup } = makeEnv();

    // Обычная задача (run_immediately по умолчанию true).
    const createResp = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: CREATION_PAYLOAD,
    });
    const issueId = createResp.json().id;

    const response = await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${issueId}/start`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toHaveProperty('error');

    await cleanup();
  });

  it('запуск несуществующей задачи → 404', async () => {
    const { app, cleanup } = makeEnv();

    const response = await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${randomUUID()}/start`,
    });
    expect(response.statusCode).toBe(404);

    await cleanup();
  });

  it('повторный запуск уже стартованного черновика → 409', async () => {
    const { app, cleanup } = makeEnv();

    // Создаём и запускаем.
    const createResp = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { ...CREATION_PAYLOAD, run_immediately: false },
    });
    const draftId = createResp.json().id;

    await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${draftId}/start`,
    });

    // Повторный запуск.
    const secondStart = await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${draftId}/start`,
    });
    expect(secondStart.statusCode).toBe(409);

    await cleanup();
  });

  it('черновик без репозиториев запускается корректно', async () => {
    const { app, cleanup } = makeEnv();

    const createResp = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { title: 'Без репозиториев', run_immediately: false },
    });
    const draftId = createResp.json().id;

    const response = await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${draftId}/start`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);

    await cleanup();
  });
});

// =========================================================================
// DELETE /issues/:id — удаление черновика
// =========================================================================

describe('DELETE /issues/:id — удаление черновика', () => {
  it('удаляет черновик: 202, запись и workspace удалены', async () => {
    const { app, db, root, cleanup } = makeEnv();

    const createResp = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { ...CREATION_PAYLOAD, run_immediately: false },
    });
    const draftId = createResp.json().id;

    // Удаляем.
    const delResp = await app.inject({
      method: 'DELETE',
      url: `${ROUTE_PATH}/${draftId}`,
    });
    expect(delResp.statusCode).toBe(202);
    expect(delResp.json().ok).toBe(true);

    // Ждём завершения фонового удаления (DB + workspace).
    await waitFor(
      () => {
        const row = getIssue(db, draftId);
        if (row !== undefined) return undefined;
        // DB records gone — give rm a tick to finish.
        return existsSync(join(root, draftId)) ? undefined : true;
      },
      5000,
      100,
    );

    // Двойная проверка.
    const issueRows = db
      .select()
      .from(issues)
      .where(eq(issues.id, draftId))
      .all();
    expect(issueRows).toHaveLength(0);
    expect(existsSync(join(root, draftId))).toBe(false);

    await cleanup();
  });

  it('черновик с файлами: при удалении файлы исчезают вместе с workspace', async () => {
    const { app, db, root, cleanup } = makeEnv();

    const { payload, headers } = multipart(
      {
        payload: JSON.stringify({
          title: 'Черновик с файлами для удаления',
          run_immediately: false,
        }),
      },
      [{ name: 'secret.txt', content: 'classified' }],
    );

    const createResp = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload,
      headers,
    });
    const draftId = createResp.json().id;
    expect(existsSync(join(root, draftId, 'attachments', 'secret.txt'))).toBe(true);

    // Удаляем.
    await app.inject({
      method: 'DELETE',
      url: `${ROUTE_PATH}/${draftId}`,
    });

    await waitFor(
      () => {
        const row = getIssue(db, draftId);
        if (row !== undefined) return undefined;
        return existsSync(join(root, draftId)) ? undefined : true;
      },
      5000,
      100,
    );

    expect(existsSync(join(root, draftId))).toBe(false);

    await cleanup();
  });
});

// =========================================================================
// Граничные случаи
// =========================================================================

describe('Граничные случаи черновиков', () => {
  it('несколько черновиков подряд → разные id, все draft', async () => {
    const { app, cleanup } = makeEnv();

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const resp = await app.inject({
        method: 'POST',
        url: ROUTE_PATH,
        payload: {
          title: `Черновик ${i + 1}`,
          run_immediately: false,
        },
      });
      expect(resp.statusCode).toBe(201);
      const body = resp.json();
      expect(body.status).toBe('draft');
      ids.push(body.id);
    }

    // Все id уникальны.
    expect(new Set(ids).size).toBe(3);

    // Все видны в списке.
    const listResp = await app.inject({ method: 'GET', url: ROUTE_PATH });
    const list = listResp.json();
    const drafts = list.filter(
      (i: { status: string }) => i.status === 'draft',
    );
    expect(drafts).toHaveLength(3);

    await cleanup();
  });

  it('черновик с jira_issue_url сохраняет source=jira', async () => {
    const { app, cleanup } = makeEnv();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: {
        title: 'Jira-черновик',
        jira_issue_url: 'https://jira.atlassian.com/browse/PROJ-123',
        run_immediately: false,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.source).toBe('jira');
    expect(body.status).toBe('draft');

    await cleanup();
  });

  it('быстрое создание → draft → instant-start без гонок', async () => {
    const { app, db, cleanup } = makeEnv();

    // Создаём и сразу запускаем.
    const createResp = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { ...CREATION_PAYLOAD, run_immediately: false },
    });
    const draftId = createResp.json().id;

    const startResp = await app.inject({
      method: 'POST',
      url: `${ROUTE_PATH}/${draftId}/start`,
    });
    expect(startResp.statusCode).toBe(200);

    // Итерация одна (не две).
    expect(countIterations(db, draftId)).toBe(1);

    await cleanup();
  });

  it('run_immediately: false с additional_context — контекст сохраняется', async () => {
    const { app, cleanup } = makeEnv();

    const response = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: {
        title: 'Черновик с контекстом',
        additional_context: 'Дополнительный контекст задачи',
        run_immediately: false,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('draft');
    expect(body.description).toBe('Дополнительный контекст задачи');

    await cleanup();
  });
});