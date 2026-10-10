import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitCliService,
  gitCachePath,
  gitTimeoutMs,
  type GitExecFile,
  type GitExecOptions,
} from '../src/git/service';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('gitTimeoutMs', () => {
  it('читает GIT_TIMEOUT_MS, иначе default 60000', () => {
    const previous = process.env.GIT_TIMEOUT_MS;
    try {
      delete process.env.GIT_TIMEOUT_MS;
      expect(gitTimeoutMs()).toBe(60_000);

      process.env.GIT_TIMEOUT_MS = '1500';
      expect(gitTimeoutMs()).toBe(1500);

      process.env.GIT_TIMEOUT_MS = 'not-a-number';
      expect(gitTimeoutMs()).toBe(60_000);
    } finally {
      if (previous === undefined) delete process.env.GIT_TIMEOUT_MS;
      else process.env.GIT_TIMEOUT_MS = previous;
    }
  });
});

describe('GitCliService — таймаут git', () => {
  it('передаёт timeout и падает понятной ошибкой при зависании clone', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'ir-ws-'));
    tempDirs.push(workspace);
    const seen: GitExecOptions[] = [];
    const exec: GitExecFile = (_file, _args, options) => {
      seen.push(options);
      return new Promise((_resolve, reject) => {
        setTimeout(() => {
          reject(
            Object.assign(new Error('Command failed: git clone'), {
              killed: true,
              signal: 'SIGTERM',
            }),
          );
        }, options.timeout);
      });
    };
    const service = new GitCliService(
      path.join(workspace, 'originals'),
      exec,
      40,
    );

    await expect(
      service.prepare({
        repoUrls: ['https://example.com/hang.git'],
        baseBranches: ['main'],
        workspacePath: workspace,
      }),
    ).rejects.toThrow(/timed out after 40ms/);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].timeout).toBe(40);
  });

  it('таймаут fetch при тёплом кэше глушится и не рушит prepare', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'ir-ws-'));
    tempDirs.push(workspace);
    const originalsRoot = path.join(workspace, 'originals');
    const repoUrl = 'https://example.com/cached.git';
    await mkdir(gitCachePath(originalsRoot, repoUrl), { recursive: true });

    const exec: GitExecFile = (_file, args, options) => {
      if (args.includes('fetch')) {
        return new Promise((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                Object.assign(new Error('fetch timed out'), { killed: true }),
              ),
            options.timeout,
          );
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const service = new GitCliService(originalsRoot, exec, 20);

    const result = await service.prepare({
      repoUrls: [repoUrl],
      baseBranches: ['main'],
      workspacePath: workspace,
    });

    expect(result.repoWorkspaces).toHaveLength(1);
    expect(result.repoWorkspaces[0].path).toBe(path.join(workspace, 'cached'));
  });
});