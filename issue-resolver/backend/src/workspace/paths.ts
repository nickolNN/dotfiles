import type { DesiredResult } from '@issue-resolver/shared';

export const DEFAULT_WORKSPACE_ROOT = '/workspaces';

const CONTAINER_WORKSPACE_ROOT = '/workspaces';

export const containerNameFor = (issueId: string): string =>
  `issue-resolver-${issueId}`;

export const workspaceHostDirFor = (root: string, issueId: string): string =>
  `${root}/${issueId}`;

export const workspaceContainerDirFor = (issueId: string): string =>
  `${CONTAINER_WORKSPACE_ROOT}/${issueId}`;

export interface ResultArtifact {
  filename: string;
  contentType: string;
}

export const HTML_ARTIFACT: ResultArtifact = {
  filename: 'report.html',
  contentType: 'text/html',
};

export const MD_ARTIFACT: ResultArtifact = {
  filename: 'report.md',
  contentType: 'text/markdown',
};

export const ALL_RESULT_ARTIFACTS: readonly ResultArtifact[] = [
  HTML_ARTIFACT,
  MD_ARTIFACT,
];

export function resultArtifactFor(
  desiredResult: DesiredResult | undefined,
): ResultArtifact | null {
  switch (desiredResult) {
    case 'md':
      return MD_ARTIFACT;
    case 'html':
      return HTML_ARTIFACT;
    default:
      return null;
  }
}

export const iterationResultDirFor = (
  root: string,
  issueId: string,
  iterationId: string,
): string => `${root}/${issueId}/.iteration-results/${iterationId}`;