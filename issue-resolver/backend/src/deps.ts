import Dockerode from 'dockerode';
import type { AppDeps } from './app';
import { DockerodeContainerController } from './docker/controller';
import { LocalContainerController } from './docker/local-controller';
import { GitCliService } from './git/service';
import { HttpJiraClient } from './jira/client';
import { RpcPiRunner } from './pi/rpc-runner';
import { InMemoryStepSessionRegistry } from './pi/session-registry';
import { HttpMrClient } from './pr/mr';
import { DEFAULT_WORKSPACE_ROOT } from './workspace/paths';

const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';
const DEFAULT_LOCAL_WORKSPACE_ROOT = '/home/agent/.issue-resolver/workspaces';

/**
 * Продуктовая фабрика deps. Без `ISSUE_RESOLVER_USE_REAL=1` возвращает пустой
 * объект — buildApp подставит безопасные Fake*-адаптеры (дефолт/тесты). Реальные
 * секреты читаются только из env и пробрасываются в конструкторы клиентов.
 *
 * `ISSUE_RESOLVER_LOCAL=1` включает локальный режим (без Docker): контейнер —
 * просто host-папка задачи, pi запускается локально (`pi --mode rpc`).
 */
export function buildDepsFromEnv(env: NodeJS.ProcessEnv): AppDeps {
  if (env.ISSUE_RESOLVER_LOCAL === '1') {
    return {
      container: new LocalContainerController(),
      git: new GitCliService(),
      pi: new RpcPiRunner('resolve', 'local'),
      mr: new HttpMrClient(env.MR_TOKEN || ''),
      jira: new HttpJiraClient(env.JIRA_BASE_URL || '', env.JIRA_TOKEN || ''),
      control: new InMemoryStepSessionRegistry(),
      workspaceRoot:
        env.ISSUE_RESOLVER_WORKSPACE_ROOT || DEFAULT_LOCAL_WORKSPACE_ROOT,
      local: true,
    };
  }

  if (env.ISSUE_RESOLVER_USE_REAL !== '1') return {};

  const docker = new Dockerode({
    socketPath: env.DOCKER_SOCKET || DEFAULT_DOCKER_SOCKET,
  });

  return {
    container: new DockerodeContainerController(docker),
    git: new GitCliService(),
    pi: new RpcPiRunner(),
    mr: new HttpMrClient(env.MR_TOKEN || ''),
    jira: new HttpJiraClient(env.JIRA_BASE_URL || '', env.JIRA_TOKEN || ''),
    control: new InMemoryStepSessionRegistry(),
    local: false,
    workspaceRoot: env.ISSUE_RESOLVER_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
  };
}