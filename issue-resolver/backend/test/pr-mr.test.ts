import { describe, expect, it } from 'vitest';
import {
  FakeMrClient,
  HttpMrClient,
  detectGitHost,
  type MrClient,
  type MrCreateInput,
} from '../src/pr/mr';

const input = (overrides: Partial<MrCreateInput> = {}): MrCreateInput => ({
  repositoryUrl: 'git@gitlab.example.com:files-web.git',
  baseBranch: 'main',
  headBranch: 'issue-resolver/abc',
  title: 'Fix EXP-1',
  description: 'Generated MR description',
  token: 'secret-token',
  source: 'gitlab',
  ...overrides,
});

describe('detectGitHost', () => {
  it('https://github.com/org/repo.git → github', () => {
    expect(detectGitHost('https://github.com/org/repo.git')).toBe('github');
  });

  it('https://gitlab.com/g/rep/blob/master/x → gitlab', () => {
    expect(detectGitHost('https://gitlab.com/g/rep/blob/master/x')).toBe('gitlab');
  });

  it('git@github.com:org/repo.git → github', () => {
    expect(detectGitHost('git@github.com:org/repo.git')).toBe('github');
  });

  it('git@gitlab.example.com:files-web.git → gitlab', () => {
    expect(detectGitHost('git@gitlab.example.com:files-web.git')).toBe('gitlab');
  });

  it('неизвестный хост → throws', () => {
    expect(() => detectGitHost('https://unknown.io/x')).toThrow(
      'unknown git host',
    );
  });
});

describe('FakeMrClient', () => {
  it('createMr → { mrUrl, id } и фиксирует входные поля', async () => {
    const client = new FakeMrClient();

    const result = await client.createMr(input());

    expect(typeof result.mrUrl).toBe('string');
    expect(result.mrUrl.length).toBeGreaterThan(0);
    expect(typeof result.id).toBe('string');
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      title: 'Fix EXP-1',
      description: 'Generated MR description',
      baseBranch: 'main',
      headBranch: 'issue-resolver/abc',
      source: 'gitlab',
      token: 'secret-token',
    });
  });

  it('failNextWith → createMr rejects', async () => {
    const client = new FakeMrClient();
    client.failNextWith(new Error('mr api down'));

    await expect(client.createMr(input())).rejects.toThrow('mr api down');
  });
});

describe('HttpMrClient', () => {
  it('совместим с интерфейсом MrClient (сигнатура компилируется)', () => {
    const client: MrClient = new HttpMrClient();
    expect(typeof client.createMr).toBe('function');
  });
});