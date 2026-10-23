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

/** Артефакт результата задачи: имя файла и его content-type. */
export interface ResultArtifact {
  filename: string;
  contentType: string;
}

/** HTML-артефакт (всегда report.html для людей). */
export const HTML_ARTIFACT: ResultArtifact = {
  filename: 'report.html',
  contentType: 'text/html',
};

/** MD-артефакт (всегда report.md для агентов). */
export const MD_ARTIFACT: ResultArtifact = {
  filename: 'report.md',
  contentType: 'text/markdown',
};

/** Все артефакты, которые агент обязан произвести. */
export const ALL_RESULT_ARTIFACTS: readonly ResultArtifact[] = [
  HTML_ARTIFACT,
  MD_ARTIFACT,
];

/**
 * Имя файла и content-type результата по desired_result.
 * Для старых задач с явным 'md'/'html' — один артефакт.
 * undefined (новые задачи) — null (используйте ALL_RESULT_ARTIFACTS).
 */
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

/** Папка снапшотов результата итерации: `.../<issueId>/.iteration-results/<iterationId>`. */
export const iterationResultDirFor = (
  root: string,
  issueId: string,
  iterationId: string,
): string => `${root}/${issueId}/.iteration-results/${iterationId}`;