import { describe, expect, it } from 'vitest';

import {
  extractRepoNameFromUrl,
  isSameRepository,
  parseRepositoryUrl,
  repositoryIdentity,
} from '../src/domain';

const BITBUCKET_BROWSE =
  'https://b.yadro.com/projects/KOS/repos/metromost_web/browse';
const BITBUCKET_CLONE = 'https://b.yadro.com/scm/kos/metromost_web.git';

describe('parseRepositoryUrl', () => {
  it('reads the project and repo out of a Bitbucket browse url', () => {
    expect(parseRepositoryUrl(BITBUCKET_BROWSE)).toEqual({
      host: 'b.yadro.com',
      project: 'KOS',
      repo: 'metromost_web',
    });
  });

  it('reads the same repo out of a Bitbucket clone url', () => {
    expect(parseRepositoryUrl(BITBUCKET_CLONE)).toEqual({
      host: 'b.yadro.com',
      project: 'kos',
      repo: 'metromost_web',
    });
  });

  it('keeps the original case of the repo name', () => {
    expect(parseRepositoryUrl('https://host.com/Proj/My-Repo.git')?.repo).toBe(
      'My-Repo',
    );
  });

  it('handles a nested browse path (src/branch/commits)', () => {
    expect(
      parseRepositoryUrl(
        'https://b.yadro.com/projects/KOS/repos/metromost_web/src/dev/src/main.tsx',
      )?.repo,
    ).toBe('metromost_web');
  });

  it('parses scp-like ssh urls', () => {
    expect(parseRepositoryUrl('git@gitlab.example.com:group/sub/repo.git')).toEqual({
      host: 'gitlab.example.com',
      project: 'sub',
      repo: 'repo',
    });
  });

  it('parses Azure DevOps _git urls', () => {
    expect(
      parseRepositoryUrl('https://dev.azure.com/org/proj/_git/repo'),
    ).toEqual({ host: 'dev.azure.com', project: 'proj', repo: 'repo' });
  });

  it('returns null for an empty or unparsable value', () => {
    expect(parseRepositoryUrl('')).toBeNull();
    expect(parseRepositoryUrl('   ')).toBeNull();
  });
});

describe('extractRepoNameFromUrl', () => {
  it('gives the repo name, not the trailing "browse" segment', () => {
    expect(extractRepoNameFromUrl(BITBUCKET_BROWSE)).toBe('metromost_web');
  });

  it('still resolves clone urls the same way (workspace dir names depend on it)', () => {
    expect(extractRepoNameFromUrl(BITBUCKET_CLONE)).toBe('metromost_web');
    expect(extractRepoNameFromUrl('https://github.com/org/repo.git')).toBe('repo');
    expect(extractRepoNameFromUrl('git@gitlab.example.com:files-web.git')).toBe(
      'files-web',
    );
  });

  it('does not strip a repo literally named like a UI segment', () => {
    expect(extractRepoNameFromUrl('https://host.com/org/tags')).toBe('tags');
  });
});

describe('repositoryIdentity', () => {
  it('is case-insensitive on host, project and repo', () => {
    expect(repositoryIdentity(BITBUCKET_BROWSE)).toBe(
      repositoryIdentity(BITBUCKET_CLONE),
    );
  });

  it('ignores the trailing slash and the .git suffix', () => {
    expect(repositoryIdentity('https://host.com/org/repo/')).toBe(
      repositoryIdentity('https://host.com/org/repo.git'),
    );
  });

  it('keeps hosts apart', () => {
    expect(repositoryIdentity('https://one.com/org/repo')).not.toBe(
      repositoryIdentity('https://two.com/org/repo'),
    );
  });
});

describe('isSameRepository', () => {
  it('matches a browse url against its clone url', () => {
    expect(isSameRepository(BITBUCKET_BROWSE, BITBUCKET_CLONE)).toBe(true);
  });

  it('matches an ssh url against its https clone url', () => {
    expect(
      isSameRepository('git@b.yadro.com:kos/metromost_web.git', BITBUCKET_CLONE),
    ).toBe(true);
  });

  it('does not match repos with the same name in different projects', () => {
    expect(
      isSameRepository(
        'https://b.yadro.com/scm/other/metromost_web.git',
        BITBUCKET_CLONE,
      ),
    ).toBe(false);
  });

  it('is false when either side is blank', () => {
    expect(isSameRepository('', BITBUCKET_CLONE)).toBe(false);
    expect(isSameRepository(BITBUCKET_BROWSE, '  ')).toBe(false);
  });
});
