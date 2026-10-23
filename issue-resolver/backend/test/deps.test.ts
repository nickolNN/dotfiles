import { describe, expect, it } from 'vitest';
import { buildDepsFromEnv } from '../src/deps';
import { DockerodeContainerController } from '../src/docker/controller';
import { LocalContainerController } from '../src/docker/local-controller';
import { GitCliService } from '../src/git/service';
import { HttpJiraClient } from '../src/jira/client';
import { RpcPiRunner } from '../src/pi/rpc-runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { HttpMrClient } from '../src/pr/mr';
import {
  DEVOPS_TIMEOUT_ENV,
  DEFAULT_DEVOPS_TIMEOUT_MS,
  LEGACY_DEVOPS_TIMEOUT_ENV,
} from '../src/workflow/timeout';

describe('buildDepsFromEnv', () => {
  it('без ISSUE_RESOLVER_USE_REAL → локальный режим по умолчанию', () => {
    const deps = buildDepsFromEnv({});
    expect(deps.container).toBeInstanceOf(LocalContainerController);
    expect(deps.pi).toBeInstanceOf(RpcPiRunner);
    expect(deps.git).toBeInstanceOf(GitCliService);
    expect(deps.mr).toBeInstanceOf(HttpMrClient);
    expect(deps.control).toBeInstanceOf(InMemoryStepSessionRegistry);
    expect(deps.local).toBe(true);

    const depsZero = buildDepsFromEnv({ ISSUE_RESOLVER_USE_REAL: '0' });
    expect(depsZero.container).toBeInstanceOf(LocalContainerController);
    expect(depsZero.local).toBe(true);
  });

  it('ISSUE_RESOLVER_USE_REAL=1 → реальные адаптеры, токены/baseUrl из env', () => {
    const deps = buildDepsFromEnv({
      ISSUE_RESOLVER_USE_REAL: '1',
      DOCKER_SOCKET: '/tmp/docker.sock',
      MR_TOKEN: 'mr-token',
      BITBUCKET_TOKEN: 'bitbucket-token',
      GITHUB_TOKEN: 'github-token',
      GITLAB_TOKEN: 'gitlab-token',
      JIRA_BASE_URL: 'https://jira.example.com',
      JIRA_TOKEN: 'jira-token',
    });

    expect(deps.container).toBeInstanceOf(DockerodeContainerController);
    expect(deps.git).toBeInstanceOf(GitCliService);
    expect(deps.pi).toBeInstanceOf(RpcPiRunner);
    expect(deps.mr).toBeInstanceOf(HttpMrClient);
    expect(deps.jira).toBeInstanceOf(HttpJiraClient);
    expect(deps.control).toBeInstanceOf(InMemoryStepSessionRegistry);

    // SAFETY: Http*Client держат token/baseUrl в private readonly; читаем их
    // runtime-свойства, чтобы убедиться, что фабрика пробросила env.
    const jira = deps.jira as unknown as { baseUrl: string; token: string };
    expect(jira.baseUrl).toBe('https://jira.example.com');
    expect(jira.token).toBe('jira-token');

    const mr = deps.mr as unknown as {
      token: string;
      tokens: Record<string, string | undefined>;
    };
    expect(mr.token).toBe('mr-token');
    // Per-host токены проброшены из env (Bitbucket-репо ходят со своим).
    expect(mr.tokens).toEqual({
      bitbucket: 'bitbucket-token',
      github: 'github-token',
      gitlab: 'gitlab-token',
    });
  });

  it('ISSUE_RESOLVER_LOCAL=1 → локальный режим без Docker', () => {
    const deps = buildDepsFromEnv({
      ISSUE_RESOLVER_LOCAL: '1',
      ISSUE_RESOLVER_WORKSPACE_ROOT: '/tmp/issue-workspaces',
      BITBUCKET_TOKEN: 'bitbucket-token',
    });

    expect(deps.container).toBeInstanceOf(LocalContainerController);
    expect(deps.pi).toBeInstanceOf(RpcPiRunner);
    expect(deps.git).toBeInstanceOf(GitCliService);
    expect(deps.control).toBeInstanceOf(InMemoryStepSessionRegistry);
    expect(deps.local).toBe(true);
    expect(deps.workspaceRoot).toBe('/tmp/issue-workspaces');
    // Локальный режим тоже прокидывает per-host MR-токены.
    expect(
      (deps.mr as unknown as { tokens: { bitbucket?: string } }).tokens
        .bitbucket,
    ).toBe('bitbucket-token');
  });

  it('devopsTimeoutMs: дефолт 30 мин, env-override и фабрика', () => {
    const defaults = buildDepsFromEnv({ ISSUE_RESOLVER_LOCAL: '1' });
    expect(defaults.devopsTimeoutMs).toBe(
      DEFAULT_DEVOPS_TIMEOUT_MS,
    );
    expect(typeof defaults.devopsFactory).toBe('function');

    const overridden = buildDepsFromEnv({
      ISSUE_RESOLVER_LOCAL: '1',
      [DEVOPS_TIMEOUT_ENV]: '120000',
    });
    expect(overridden.devopsTimeoutMs).toBe(120_000);

    // Фолбэк на прежнее имя env при отсутствии нового.
    const legacy = buildDepsFromEnv({
      ISSUE_RESOLVER_LOCAL: '1',
      [LEGACY_DEVOPS_TIMEOUT_ENV]: '120000',
    });
    expect(legacy.devopsTimeoutMs).toBe(120_000);

    // Новое имя приоритетнее прежнего.
    const both = buildDepsFromEnv({
      ISSUE_RESOLVER_LOCAL: '1',
      [DEVOPS_TIMEOUT_ENV]: '180000',
      [LEGACY_DEVOPS_TIMEOUT_ENV]: '120000',
    });
    expect(both.devopsTimeoutMs).toBe(180_000);
  });
});