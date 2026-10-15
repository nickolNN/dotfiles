import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DB_PATH, dbPathFromEnv } from '../src/db/client';
import { buildDepsFromEnv } from '../src/deps';
import {
  DEFAULT_ORIGINALS_ROOT,
  GitCliService,
  originalsRootFromEnv,
} from '../src/git/service';

const originalsRootOf = (git: unknown): string =>
  (git as { originalsRoot: string }).originalsRoot;

describe('dbPathFromEnv', () => {
  it('ISSUE_RESOLVER_DATA_DIR задан → <DATA_DIR>/issue-resolver.db', () => {
    expect(dbPathFromEnv({ ISSUE_RESOLVER_DATA_DIR: '/data/ir' })).toBe(
      join('/data/ir', 'issue-resolver.db'),
    );
  });

  it('DATA_DIR не задан → DEFAULT_DB_PATH (текущее поведение)', () => {
    expect(dbPathFromEnv({})).toBe(DEFAULT_DB_PATH);
  });
});

describe('originalsRootFromEnv', () => {
  it('ISSUE_RESOLVER_DATA_DIR задан → <DATA_DIR>/originals', () => {
    expect(originalsRootFromEnv({ ISSUE_RESOLVER_DATA_DIR: '/data/ir' })).toBe(
      join('/data/ir', 'originals'),
    );
  });

  it('DATA_DIR не задан → /tmp/issue-resolver/originals', () => {
    expect(originalsRootFromEnv({})).toBe(DEFAULT_ORIGINALS_ROOT);
    expect(originalsRootFromEnv({})).toBe('/tmp/issue-resolver/originals');
  });
});

describe('buildDepsFromEnv — ISSUE_RESOLVER_DATA_DIR', () => {
  it('local: DATA_DIR выводит workspaces и originals', () => {
    const deps = buildDepsFromEnv({
      ISSUE_RESOLVER_LOCAL: '1',
      ISSUE_RESOLVER_DATA_DIR: '/data/ir',
    });

    expect(deps.workspaceRoot).toBe(join('/data/ir', 'workspaces'));
    expect(originalsRootOf(deps.git)).toBe(join('/data/ir', 'originals'));
  });

  it('local: DATA_DIR не задан → прежние дефолты', () => {
    const deps = buildDepsFromEnv({ ISSUE_RESOLVER_LOCAL: '1' });

    expect(deps.workspaceRoot).toBe(
      '/home/agent/workspace/.issue-resolver/workspaces',
    );
    expect(originalsRootOf(deps.git)).toBe('/tmp/issue-resolver/originals');
  });

  it('local: WORKSPACE_ROOT приоритетнее DATA_DIR', () => {
    const deps = buildDepsFromEnv({
      ISSUE_RESOLVER_LOCAL: '1',
      ISSUE_RESOLVER_DATA_DIR: '/data/ir',
      ISSUE_RESOLVER_WORKSPACE_ROOT: '/tmp/ws',
    });

    expect(deps.workspaceRoot).toBe('/tmp/ws');
    // originals по-прежнему выводится из DATA_DIR
    expect(originalsRootOf(deps.git)).toBe(join('/data/ir', 'originals'));
  });

  it('docker: DATA_DIR выводит workspaces и originals', () => {
    const deps = buildDepsFromEnv({
      ISSUE_RESOLVER_USE_REAL: '1',
      ISSUE_RESOLVER_DATA_DIR: '/data/ir',
    });

    expect(deps.git).toBeInstanceOf(GitCliService);
    expect(deps.workspaceRoot).toBe(join('/data/ir', 'workspaces'));
    expect(originalsRootOf(deps.git)).toBe(join('/data/ir', 'originals'));
  });

  it('docker: DATA_DIR не задан → прежние дефолты', () => {
    const deps = buildDepsFromEnv({ ISSUE_RESOLVER_USE_REAL: '1' });

    expect(deps.workspaceRoot).toBe('/workspaces');
    expect(originalsRootOf(deps.git)).toBe('/tmp/issue-resolver/originals');
  });
});