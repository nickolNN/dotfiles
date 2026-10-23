import { join } from 'node:path';
import Dockerode from 'dockerode';
import type { AppDeps } from './app';
import { DockerodeContainerController } from './docker/controller';
import { LocalContainerController } from './docker/local-controller';
import { GitCliService, originalsRootFromEnv } from './git/service';
import { HttpJiraClient } from './jira/client';
import { RpcPiRunner } from './pi/rpc-runner';
import { InMemoryStepSessionRegistry } from './pi/session-registry';
import { HttpMrClient } from './pr/mr';
import { PiDevOpsAgent } from './workflow/devops';
import type { DevOpsFactory } from './workflow/engine';
import {
  DEVOPS_TIMEOUT_ENV,
  LEGACY_DEVOPS_TIMEOUT_ENV,
  resolveDevOpsTimeoutMs,
} from './workflow/timeout';
import { DEFAULT_WORKSPACE_ROOT } from './workspace/paths';

const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';

/**
 * Продуктовая фабрика агента-анализатора: переиспользует тот же экземпляр
 * `PiRunner`, что и шаги конвейера, и пишет `run_instructions` через порт БД
 * (создаётся в `runIssueIteration`). Без неё анализ не запускается (фейковый
 * дефолт/тесты).
 */
export function devOpsFactoryFor(
  pi: RpcPiRunner,
  defaultTimeoutMs: number,
): DevOpsFactory {
  return ({
    containerName,
    hostWorkspaceDir,
    issueId,
    iterationId,
    stepRunId,
    registry,
    tagInstructions,
    reposNames,
    reposRequireDevServer,
    reposInstructions,
    model,
    thinkingLevel,
    timeoutMs,
    onStdout,
    onStderr,
  }) =>
    new PiDevOpsAgent({
      pi,
      containerName,
      hostWorkspaceDir,
      issueId,
      iterationId,
      stepRunId,
      registry,
      tagInstructions,
      reposNames,
      reposRequireDevServer,
      reposInstructions,
      model,
      thinkingLevel,
      timeoutMs: timeoutMs ?? defaultTimeoutMs,
      onStdout,
      onStderr,
    });
}

/**
 * Дефолтный корень workspace-папок в локальном режиме (без Docker).
 *
 * Лежит на host-bind-mount `/home/agent/workspace` (virtiofs), поэтому
 * артефакты задач (`report.html`/`index.html` и т.п.) переживают
 * пересоздание контейнера/комнаты, и download-эндпоинты не отдают 404.
 *
 * Почему не `/home/agent/.issue-resolver`: этот каталог живёт на
 * эфемерном overlay-слое контейнера и исчезает при рестарте комнаты
 * (durable volume'ами в `.pi` покрыты только memory/rooms/sessions).
 *
 * Переопределяется env `ISSUE_RESOLVER_WORKSPACE_ROOT` (см. buildDepsFromEnv).
 */
const DEFAULT_LOCAL_WORKSPACE_ROOT =
  '/home/agent/workspace/.issue-resolver/workspaces';

/**
 * Продуктовая фабрика deps. Без `ISSUE_RESOLVER_USE_REAL=1` возвращает пустой
 * объект — buildApp подставит безопасные Fake*-адаптеры (дефолт/тесты). Реальные
 * секреты читаются только из env и пробрасываются в конструкторы клиентов.
 *
 * `ISSUE_RESOLVER_LOCAL=1` включает локальный режим (без Docker): контейнер —
 * просто host-папка задачи, pi запускается локально (`pi --mode rpc`).
 */
export function buildDepsFromEnv(env: NodeJS.ProcessEnv): AppDeps {
  // Docker-режим: явный флаг ISSUE_RESOLVER_USE_REAL=1.
  if (env.ISSUE_RESOLVER_USE_REAL === '1') {
    const docker = new Dockerode({
      socketPath: env.DOCKER_SOCKET || DEFAULT_DOCKER_SOCKET,
    });
    const pi = new RpcPiRunner();
    const devopsTimeoutMs = resolveDevOpsTimeoutMs(
      env[DEVOPS_TIMEOUT_ENV] ?? env[LEGACY_DEVOPS_TIMEOUT_ENV],
    );

    return {
      container: new DockerodeContainerController(docker),
      git: new GitCliService(originalsRootFromEnv(env)),
      pi,
      mr: new HttpMrClient(env.MR_TOKEN || '', {
        bitbucket: env.BITBUCKET_TOKEN || '',
        github: env.GITHUB_TOKEN || '',
        gitlab: env.GITLAB_TOKEN || '',
      }),
      jira: new HttpJiraClient(env.JIRA_BASE_URL || '', env.JIRA_TOKEN || ''),
      control: new InMemoryStepSessionRegistry(),
      devopsFactory: devOpsFactoryFor(pi, devopsTimeoutMs),
      devopsTimeoutMs,
      local: false,
      workspaceRoot:
        env.ISSUE_RESOLVER_WORKSPACE_ROOT ||
        (env.ISSUE_RESOLVER_DATA_DIR
          ? join(env.ISSUE_RESOLVER_DATA_DIR, 'workspaces')
          : DEFAULT_WORKSPACE_ROOT),
    };
  }

  // По умолчанию — локальный режим (без Docker).
  const pi = new RpcPiRunner('resolve', 'local');
  const devopsTimeoutMs = resolveDevOpsTimeoutMs(
    env[DEVOPS_TIMEOUT_ENV] ?? env[LEGACY_DEVOPS_TIMEOUT_ENV],
  );
  return {
    container: new LocalContainerController(),
    git: new GitCliService(originalsRootFromEnv(env)),
    pi,
    mr: new HttpMrClient(env.MR_TOKEN || '', {
      bitbucket: env.BITBUCKET_TOKEN || '',
      github: env.GITHUB_TOKEN || '',
      gitlab: env.GITLAB_TOKEN || '',
    }),
    jira: new HttpJiraClient(env.JIRA_BASE_URL || '', env.JIRA_TOKEN || ''),
    control: new InMemoryStepSessionRegistry(),
    devopsFactory: devOpsFactoryFor(pi, devopsTimeoutMs),
    devopsTimeoutMs,
    workspaceRoot:
      env.ISSUE_RESOLVER_WORKSPACE_ROOT ||
      (env.ISSUE_RESOLVER_DATA_DIR
        ? join(env.ISSUE_RESOLVER_DATA_DIR, 'workspaces')
        : DEFAULT_LOCAL_WORKSPACE_ROOT),
    local: true,
  };
}