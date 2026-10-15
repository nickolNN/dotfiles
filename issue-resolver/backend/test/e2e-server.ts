/**
 * E2E-сервер для Playwright: реальные HTTP-роуты и движок поверх
 * детерминированных фейков (без Docker/git/pi/сети/токенов). Поднимается
 * webServer'ом Playwright (script `start:e2e`); БД и workspace живут в
 * `ISSUE_RESOLVER_DATA_DIR` (Playwright передаёт свежий временный каталог).
 *
 * Зачем отдельный сервер, а не `src/server.ts`: продуктовый сервер с
 * фейковыми адаптерами не умеет `bootstrap_log` (нет `bootstrapperFactory`) и
 * не даёт управлять ответами агента. Здесь инжектируем:
 *  1. офлайн-валидатор репозиториев (никакой сети → детерминизм);
 *  2. фабрику анализатора с живым stdout/stderr → SSE `bootstrap_log`;
 *  3. сценарный pi-раннер (`ScenarioPiRunner`): ответы шагов
 *     success/failure/question/timeout задаются через `POST /e2e/scenarios`.
 *
 * Управление сценарием: `POST /e2e/scenarios` (встроенное имя или inline
 * `steps`), `POST /e2e/reset`, `GET /e2e/scenarios`.
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoInfo } from '@issue-resolver/shared';
import { buildApp } from '../src/app';
import { createDb, dbPathFromEnv } from '../src/db/client';
import { reconcileInterruptedRuns } from '../src/db/reconcile';
import { FakeContainerController } from '../src/docker/controller';
import { FakeMrClient } from '../src/pr/mr';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { InMemorySseHub } from '../src/sse/hub';
import type { RepoResolverFactory } from '../src/repo-resolver/resolver';
import type { ReposValidator } from '../src/repo-resolver/validate';
import {
  ScenarioController,
  ScenarioGitService,
  ScenarioPiRunner,
  createScenarioBootstrapperFactory,
  registerScenarioRoutes,
} from './e2e-scenarios';

const bootstrapHoldMs = Number(process.env.E2E_BOOTSTRAP_HOLD_MS ?? 300);

/** Фиксированные метаданные для любого URL — валидация без сети. */
const fakeRepoInfo = (url: string): RepoInfo => ({
  platform: 'github',
  fullName: 'e2e/example',
  defaultBranch: 'main',
  branches: ['main', 'develop'],
  language: 'TypeScript',
  description: 'E2E fixture repository',
  stars: 0,
  isPrivate: false,
  cloneUrl: url,
  writeAccess: true,
});

const fakeReposValidator: ReposValidator = async (urls) =>
  urls.map((url) => ({
    url,
    valid: true,
    platform: 'github',
    info: fakeRepoInfo(url),
  }));

/**
 * Фабрика резолверов: `POST/PUT /repositories` и `/branches` ходят в `resolveOne`,
 * который использует именно фабрику (а не инжектируемый `validate`), поэтому
 * офлайн-резолвер задаётся здесь.
 */
const fakeResolverFactory: RepoResolverFactory = () => ({
  resolve: async (url: string) => fakeRepoInfo(url),
});

const dataDir =
  process.env.ISSUE_RESOLVER_DATA_DIR ??
  (await mkdtemp(join(tmpdir(), 'issue-resolver-e2e-')));
await mkdir(dataDir, { recursive: true });
process.env.ISSUE_RESOLVER_DATA_DIR = dataDir;

const db = createDb(dbPathFromEnv(process.env));
reconcileInterruptedRuns(db);

const scenarioController = new ScenarioController();
const piRunner = new ScenarioPiRunner(scenarioController);

const app = buildApp(db, {
  container: new FakeContainerController(),
  git: new ScenarioGitService(scenarioController),
  pi: piRunner,
  mr: new FakeMrClient(),
  sse: new InMemorySseHub(),
  control: new InMemoryStepSessionRegistry(),
  repos: fakeReposValidator,
  repoResolverFactory: fakeResolverFactory,
  bootstrapperFactory: createScenarioBootstrapperFactory(scenarioController, {
    holdMs: bootstrapHoldMs,
  }),
  workspaceRoot: join(dataDir, 'workspaces'),
  local: true,
});

registerScenarioRoutes(app, { controller: scenarioController, runner: piRunner });

const port = Number(process.env.PORT) || 8080;
await app.listen({ host: '0.0.0.0', port });
console.log(
  `[e2e] issue-resolver test server on http://localhost:${port} (data: ${dataDir})`,
);