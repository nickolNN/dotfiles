import { useCallback, useEffect, useRef, useState } from 'react';
import {
  extractIssueKeyFromUrl,
  extractRepoNameFromUrl,
  formatRelativeTime,
  type Issue,
  type TaskStatus,
} from '@issue-resolver/shared';
import { deleteIssue, getIssues } from '../api/client';
import { statusColor } from '../theme';

interface TasksListProps {
  onOpenTask?: (issueId: string) => void;
  onCreateTask?: () => void;
  onOpenResult?: (issueId: string) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; issues: Issue[] };

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'В очереди',
  running: 'В работе',
  completed: 'Завершено',
  failed: 'Ошибка',
  cancelled: 'Отменено',
};

function issueKey(issue: Issue): string {
  return (
    extractIssueKeyFromUrl(issue.jira_issue_url ?? '') ||
    issue.title.trim() ||
    issue.id
  );
}

function repositoryNames(issue: Issue): string {
  return issue.repositories
    .map((repository) => extractRepoNameFromUrl(repository.repository_url))
    .filter((name) => name.length > 0)
    .join(', ');
}

function branchNames(issue: Issue): string {
  return issue.repositories
    .map((repository) => repository.branch_name)
    .filter((name) => name.length > 0)
    .join(', ');
}

/** Просматриваемый результат есть у завершённой задачи с md/html-артефактом. */
function hasViewableResult(issue: Issue): boolean {
  return (
    issue.status === 'completed' &&
    (issue.desired_result === 'md' || issue.desired_result === 'html')
  );
}

const cellClass = 'border-b border-[#008F11]/40 px-3 py-3 align-top';

/** Inline-иконка «плюс» для кнопки создания задачи, без внешних зависимостей. */
function PlusIcon() {
  return (
    <svg
      className="h-5 w-5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Inline-иконка мусорного ведра, без внешних зависимостей. */
function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export default function TasksList({
  onOpenTask,
  onCreateTask,
  onOpenResult,
}: TasksListProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const issues = await getIssues();
      if (mountedRef.current) setState({ status: 'ready', issues });
    } catch (error: unknown) {
      if (mountedRef.current) {
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();

    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm('Удалить задачу и всю её рабочую папку?')) return;

      setActionError(null);
      try {
        await deleteIssue(id);
        await load();
      } catch (error: unknown) {
        setActionError(error instanceof Error ? error.message : String(error));
      }
    },
    [load],
  );

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[#008F11]/40 pb-4">
        <div>
          <h2 className="glow text-xl font-semibold text-[#00FF41]">
            Мои задачи
          </h2>
          <p className="text-sm text-[#00FF41]/60">
            История запусков Issue Resolver
          </p>
        </div>
        <button
          type="button"
          aria-label="Создать задачу"
          title="Создать задачу"
          className="inline-flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-none border border-[#008F11] text-[#00FF41] transition-colors hover:bg-[#008F11]/20 hover:shadow-[0_0_10px_rgba(0,255,65,0.35)]"
          onClick={() => onCreateTask?.()}
        >
          <PlusIcon />
        </button>
      </header>

      <section className="panel py-6 px-3 sm:px-4 md:px-6">
        {actionError && (
          <p role="alert" className="mb-4 text-sm font-medium text-[#FF0033]">
            Не удалось удалить задачу: {actionError}
          </p>
        )}

        {state.status === 'loading' && (
          <p className="text-sm text-[#00FF41]/60">Загрузка…</p>
        )}

        {state.status === 'error' && (
          <p role="alert" className="text-sm font-medium text-[#FF0033]">
            Не удалось загрузить задачи: {state.message}
          </p>
        )}

        {state.status === 'ready' && state.issues.length === 0 && (
          <div className="rounded-none border border-dashed border-[#008F11] p-8 text-center text-sm text-[#00FF41]/60">
            Пока нет ни одной задачи.
          </div>
        )}

        {state.status === 'ready' && state.issues.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-[#00FF41]/60">
                  <th className={cellClass}>Задача</th>
                  <th className={cellClass}>Статус</th>
                  <th className={cellClass}>Результат</th>
                  <th className={cellClass}>Репозитории</th>
                  <th className={cellClass}>Ветки</th>
                  <th className={cellClass}>Создано</th>
                  <th className={cellClass}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {state.issues.map((issue) => (
                  <tr
                    key={issue.id}
                    className="cursor-pointer hover:bg-[#008F11]/10"
                    onClick={() => onOpenTask?.(issue.id)}
                  >
                    <td className={cellClass}>
                      <span className="font-medium text-[#00FF41]">
                        {issueKey(issue)}
                      </span>
                      {issue.jira_issue_url && (
                        <span className="mt-0.5 block break-all text-xs text-[#00FF41]/50">
                          {issue.jira_issue_url}
                        </span>
                      )}
                    </td>
                    <td className={cellClass}>
                      <span
                        className="inline-block border px-2 py-0.5 text-xs"
                        style={{
                          color: statusColor[issue.status],
                          borderColor: statusColor[issue.status],
                        }}
                      >
                        {STATUS_LABELS[issue.status]}
                      </span>
                    </td>
                    <td
                      data-testid="result-cell"
                      className={`${cellClass} whitespace-nowrap`}
                    >
                      {hasViewableResult(issue) ? (
                        <button
                          type="button"
                          aria-label={`Просмотреть результат ${issueKey(issue)}`}
                          title="Просмотреть результат"
                          className="rounded-none border border-[#008F11] px-2 py-1 text-xs text-[#00FF41] hover:bg-[#008F11]/20"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenResult?.(issue.id);
                          }}
                        >
                          Просмотр
                        </button>
                      ) : (
                        <span className="text-[#00FF41]/40">—</span>
                      )}
                    </td>
                    <td className={`${cellClass} text-[#00FF41]/80`}>
                      {repositoryNames(issue) || '—'}
                    </td>
                    <td className={`${cellClass} text-[#00FF41]/80`}>
                      {branchNames(issue) || '—'}
                    </td>
                    <td
                      className={`${cellClass} whitespace-nowrap text-[#00FF41]/80`}
                    >
                      {formatRelativeTime(issue.created_at)}
                    </td>
                    <td className={`${cellClass} whitespace-nowrap`}>
                      <button
                        type="button"
                        data-testid="delete-issue"
                        aria-label={`Удалить задачу ${issueKey(issue)}`}
                        title="Удалить задачу"
                        className="inline-flex min-h-6 items-center justify-center rounded-none p-1 text-[#FF0033]/50 hover:text-[#FF0033] hover:bg-transparent focus-visible:text-[#FF0033]"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDelete(issue.id);
                        }}
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
