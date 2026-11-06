import { bitbucketProjectRepo } from '../repo-resolver/url';

export function pathOfMrUrl(mrUrl: string): string {
  try {
    return new URL(mrUrl).pathname;
  } catch {
    return mrUrl;
  }
}

export function bitbucketProjectRepoFromMrUrl(mrUrl: string): {
  project: string;
  repo: string;
  id: string;
} {
  const path = pathOfMrUrl(mrUrl);
  const match =
    /\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)(?=\/|$)/.exec(
      path,
    );
  if (!match) {
    throw new Error(
      `cannot parse bitbucket pr url: ${mrUrl} — expected "projects/<PROJECT>/repos/<REPO>/pull-requests/<ID>" anywhere in the path`,
    );
  }
  return { project: match[1], repo: match[2], id: match[3] };
}

export function bitbucketMrWebUrl(
  host: string,
  project: string,
  repo: string,
  id: string,
  links?: { self?: Array<{ href?: string }> },
): string {
  const self = links?.self?.find((link) => link.href)?.href;
  if (self) return self;
  return `https://${host}/projects/${project}/repos/${repo}/pull-requests/${id}`;
}

export function bitbucketCloudParts(
  mrUrl: string,
  repositoryUrl?: string,
): { workspace: string; repo: string; id: string } {
  const match = /\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/.exec(mrUrl);
  if (match) {
    return {
      workspace: decodeURIComponent(match[1]),
      repo: decodeURIComponent(match[2]).replace(/\.git$/, ''),
      id: match[3],
    };
  }
  const id = /\/pull-requests\/(\d+)/.exec(mrUrl)?.[1];
  if (repositoryUrl && id) {
    const { project, repo } = bitbucketProjectRepo(repositoryUrl);
    return { workspace: project, repo, id };
  }
  throw new Error(
    `cannot parse bitbucket cloud pr url: ${mrUrl} — ожидается https://bitbucket.org/{workspace}/{repo}/pull-requests/{id}`,
  );
}

export function bitbucketCloudMrWebUrl(
  htmlUrl: string | undefined,
  workspace: string,
  repo: string,
  id: string,
): string {
  return (
    htmlUrl ??
    `https://bitbucket.org/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pull-requests/${id}`
  );
}
