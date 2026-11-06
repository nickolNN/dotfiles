import { RepoPlatform } from '@issue-resolver/shared';

export const DEFAULT_GITHUB_HOST = 'github.com';
export const DEFAULT_GITLAB_HOST = 'gitlab.com';
export const DEFAULT_BITBUCKET_HOST = 'bitbucket.org';

export function hostOf(url: string): string {
  const trimmed = url.trim();
  const sshMatch = /^[^@/]+@([^:/]+)[:/]/.exec(trimmed);
  if (sshMatch) {
    return sshMatch[1].toLowerCase();
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function repoPathOf(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, '');
  const sshMatch = /^[^@/]+@[^:/]+[:/](.+)$/.exec(trimmed);
  if (sshMatch) {
    return sshMatch[1].replace(/^\/+/, '');
  }
  try {
    return new URL(trimmed).pathname.replace(/^\/+/, '');
  } catch {
    throw new Error(`cannot parse repository url: ${url}`);
  }
}

export function githubOwnerRepo(url: string): { owner: string; repo: string } {
  const segments = repoPathOf(url)
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new Error(`cannot parse github repository: ${url}`);
  }
  return { owner: segments[0], repo: segments[1] };
}

export function isBitbucketCloudHost(host: string): boolean {
  return host === 'bitbucket.org';
}

export function bitbucketProjectRepo(url: string): {
  project: string;
  repo: string;
} {
  const segments = repoPathOf(url)
    .split('/')
    .filter((segment) => segment.length > 0);

  if (isBitbucketCloudHost(hostOf(url))) {
    if (segments.length < 2) {
      throw new Error(`cannot parse bitbucket repository: ${url}`);
    }
    return { project: segments[0], repo: segments[1] };
  }

  if (segments[0]?.toLowerCase() === 'scm') {
    if (segments.length < 3) {
      throw new Error(`cannot parse bitbucket repository: ${url}`);
    }
    return { project: segments[1], repo: segments[2] };
  }

  const projectsIndex = segments.findIndex(
    (segment) => segment.toLowerCase() === 'projects',
  );
  const reposIndex = segments.findIndex(
    (segment, index) =>
      index > projectsIndex && segment.toLowerCase() === 'repos',
  );
  if (projectsIndex !== -1 && reposIndex !== -1) {
    return {
      project: segments[projectsIndex + 1],
      repo: segments[reposIndex + 1],
    };
  }

  if (segments.length >= 2) {
    return { project: segments[0], repo: segments[1] };
  }

  throw new Error(`cannot parse bitbucket repository: ${url}`);
}

export function detectPlatform(url: string): RepoPlatform {
  const host = hostOf(url);
  if (!host) {
    return RepoPlatform.unknown;
  }
  if (host.includes('github')) {
    return RepoPlatform.github;
  }
  if (host.includes('gitlab')) {
    return RepoPlatform.gitlab;
  }
  return RepoPlatform.bitbucket;
}