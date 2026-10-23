import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThinkingLevel } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
import { iterations } from '../src/db/schema';
import { resetPortAllocator } from '../src/port-allocator';
import type { DevOpsFactory } from '../src/workflow/engine';

/**
 * Регресс-тест на `devops_thinking_level` в маршрутах, которые ЗАПУСКАЮТ
 * подготовку рабочей папки. Проверяется не персистентность (её тестит
 * `devops.test.ts`/`thinking.test.ts`), а то, что значение доезжает до
 * `prepareDeps` → `DevOpsFactory` → агент.
 *
 * Почему тест нужен именно здесь: `prepareDeps` в маршрутах — выведенная
 * переменная, поэтому excess-property check TypeScript не срабатывает, и
 * пропущенное поле `devopsThinkingLevel` не ловится ни `tsc`, ни zod (в zod
 * нет `strict()`/`passthrough()` → неизвестные ключи молча strip'аются).
 * Единственный надёжный арбитр — наблюдать фабрику агента в рантайме.
 *
 * Покрытые места:
 *  - `POST /issues/:id/iterations` → `routes/issues.ts` (`devopsThinkingLevel`
 *    из тела запроса, `createIterationRequestSchema` должен его принимать);
 *  - `POST /iterations/:id/repeat` → `routes/iterations.ts` (`devopsModel` /
 *    `devopsThinkingLevel` берутся из сохранённой задачи, а не undefined).
 */

const ISSUES = '/issue-resolver/api/v1/issues';
const ITERATIONS = '/issue-resolver/api/v1/iterations';

const REPOSITORIES = [
  { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
];

interface CapturedDevOpsParams {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

interface TestEnv {
  db: Db;
  app: ReturnType<typeof buildApp>;
  calls: CapturedDevOpsParams[];
  cleanup: () => Promise<void>;
}

const openCleanups: Array<() => Promise<void>> = [];

function makeEnv(): TestEnv {
  const db = createDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'devops-iter-thinking-'));
  // Фабрика-шпион: запоминает опции, с которыми движок создаёт DevOps-агента.
  // Возвращённый агент ничего не делает — проверяется только проброс настроек.
  const calls: CapturedDevOpsParams[] = [];
  const devopsFactory: DevOpsFactory = (params) => {
    calls.push({ model: params.model, thinkingLevel: params.thinkingLevel });
    return {
      runDevOps: async () => ({ success: true, instructions: 'RUN' }),
    };
  };
  const app = buildApp(db, { devopsFactory, workspaceRoot: root });
  const cleanup = async (): Promise<void> => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    resetPortAllocator();
  };
  openCleanups.push(cleanup);
  return { db, app, calls, cleanup };
}

afterEach(async () => {
  await Promise.all(openCleanups.splice(0).map((cleanup) => cleanup()));
});

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 3000,
  stepMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error('waitFor: таймаут ожидания условия');
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Ждёт появления хотя бы одного вызова фабрики и отдаёт последний. */
async function lastDevOpsCall(
  calls: CapturedDevOpsParams[],
): Promise<CapturedDevOpsParams> {
  await waitFor(() => (calls.length > 0 ? calls.length : undefined));
  return calls[calls.length - 1];
}

describe('devops_thinking_level доезжает до DevOps-агента', () => {
  it('POST /issues/:id/iterations передаёт devops_model/devops_thinking_level из тела', async () => {
    const { app, calls } = makeEnv();

    // Черновик без immediate-запуска: нет активной итерации и не запускается
    // подготовка преждевременно — фабрика вызовется только на POST /iterations.
    const created = await app.inject({
      method: 'POST',
      url: ISSUES,
      payload: {
        title: 'Итерация с thinking',
        repositories: REPOSITORIES,
        run_immediately: false,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe('draft');
    const issueId = created.json().id as string;
    expect(calls).toHaveLength(0);

    const iteration = await app.inject({
      method: 'POST',
      url: `${ISSUES}/${issueId}/iterations`,
      payload: {
        context: 'analyze',
        devops_model: 'opus',
        devops_thinking_level: 'high',
      },
    });
    expect(iteration.statusCode).toBe(201);

    expect(await lastDevOpsCall(calls)).toEqual({
      model: 'opus',
      thinkingLevel: 'high',
    });
  });

  it('POST /iterations/:id/repeat берёт настройки из сохранённой задачи', async () => {
    const { db, app, calls } = makeEnv();

    const created = await app.inject({
      method: 'POST',
      url: ISSUES,
      payload: {
        title: 'Повтор с thinking',
        repositories: REPOSITORIES,
        run_immediately: false,
        devops_model: 'opus',
        devops_thinking_level: 'xhigh',
      },
    });
    expect(created.statusCode).toBe(201);
    const issueId = created.json().id as string;

    // Готовая исходная итерация: повтор разрешён (статус не active).
    const now = new Date().toISOString();
    const sourceId = randomUUID();
    db.insert(iterations)
      .values({
        id: sourceId,
        issue_id: issueId,
        number: 1,
        context: 'исходный',
        steps: ['resolve'],
        status: 'completed',
        created_at: now,
        updated_at: now,
      })
      .run();

    const repeat = await app.inject({
      method: 'POST',
      url: `${ITERATIONS}/${sourceId}/repeat`,
    });
    expect(repeat.statusCode).toBe(201);

    expect(await lastDevOpsCall(calls)).toEqual({
      model: 'opus',
      thinkingLevel: 'xhigh',
    });
  });

  it('POST /issues с run_immediately:true передаёт настройки из тела в первый же прогон', async () => {
    const { app, calls } = makeEnv();

    // Самый пользовательский путь: задачу создают и сразу запускают. Типы тут
    // молчат (объект-литерал теряет excess-property check) — ловится только
    // фактическим вызовом DevOps-агента.
    const created = await app.inject({
      method: 'POST',
      url: ISSUES,
      payload: {
        title: 'Немедленный запуск',
        repositories: REPOSITORIES,
        run_immediately: true,
        devops_model: 'opus',
        devops_thinking_level: 'high',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe('pending');

    expect(await lastDevOpsCall(calls)).toEqual({
      model: 'opus',
      thinkingLevel: 'high',
    });
  });
});