/**
 * Единый источник путей рабочей папки задачи и имени контейнера.
 *
 * Host-путь (`workspaceHostDirFor`) используется для bind-mount и git-операций
 * на хосте, container-путь (`workspaceContainerDirFor`) — как cwd процесса pi
 * внутри контейнера. При дефолтном root они совпадают с историческим
 * `/workspaces/<issueId>`.
 */
import type { DesiredResult } from '@issue-resolver/shared';

export const DEFAULT_WORKSPACE_ROOT = '/workspaces';

const CONTAINER_WORKSPACE_ROOT = '/workspaces';

export const containerNameFor = (issueId: string): string =>
  `issue-resolver-${issueId}`;

export const workspaceHostDirFor = (root: string, issueId: string): string =>
  `${root}/${issueId}`;

export const workspaceContainerDirFor = (issueId: string): string =>
  `${CONTAINER_WORKSPACE_ROOT}/${issueId}`;

/** Артефакт результата задачи: имя файла и его content-type по desired_result. */
export interface ResultArtifact {
  filename: string;
  contentType: string;
}

/**
 * Имя файла и content-type результата по desired_result. undefined трактуется
 * как 'md'. Для неизвестного значения — null (артефакта нет).
 */
export function resultArtifactFor(
  desiredResult: DesiredResult | undefined,
): ResultArtifact | null {
  switch (desiredResult) {
    case undefined:
    case 'md':
      return { filename: 'report.md', contentType: 'text/markdown' };
    case 'html':
      return { filename: 'report.html', contentType: 'text/html' };
    case 'pr':
      return { filename: 'result.json', contentType: 'application/json' };
    default:
      return null;
  }
}

/** Папка снапшотов результата итерации: `.../<issueId>/.iteration-results/<iterationId>`. */
export const iterationResultDirFor = (
  root: string,
  issueId: string,
  iterationId: string,
): string => `${root}/${issueId}/.iteration-results/${iterationId}`;