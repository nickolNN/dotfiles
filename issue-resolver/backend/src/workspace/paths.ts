/**
 * Единый источник путей рабочей папки задачи и имени контейнера.
 *
 * Host-путь (`workspaceHostDirFor`) используется для bind-mount и git-операций
 * на хосте, container-путь (`workspaceContainerDirFor`) — как cwd процесса pi
 * внутри контейнера. При дефолтном root они совпадают с историческим
 * `/workspaces/<issueId>`.
 */
export const DEFAULT_WORKSPACE_ROOT = '/workspaces';

const CONTAINER_WORKSPACE_ROOT = '/workspaces';

export const containerNameFor = (issueId: string): string =>
  `issue-resolver-${issueId}`;

export const workspaceHostDirFor = (root: string, issueId: string): string =>
  `${root}/${issueId}`;

export const workspaceContainerDirFor = (issueId: string): string =>
  `${CONTAINER_WORKSPACE_ROOT}/${issueId}`;