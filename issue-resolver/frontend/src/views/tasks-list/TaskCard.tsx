import { formatRelativeTime, TaskStatus, type IssueDeletingPhase, type SavedRepo } from '@issue-resolver/shared';
import { statusColor } from '../../theme';
import {
  DELETE_PHASE_LABELS,
  NO_DOT_STATUSES,
  PULSE_STATUSES,
  STATUS_LABELS,
  TERMINAL_STATUSES,
} from './constants';
import { cardAnimation } from '../../lib/animations';
import {
  hasViewableResult,
  issueKey,
  repositoryNames,
  showsIssueStats,
  showsRepoReadiness,
} from './format';
import IssueStats from './IssueStats';
import ParallelIcon from '../../components/icons/ParallelIcon';
import StopIcon from '../../components/icons/StopIcon';
import TrashIcon from '../../components/icons/TrashIcon';
import RepoReadinessLine from './RepoReadinessLine';
import type { CardActions, IssueWithActiveStep } from './types';

function accentClass(
  isTerminal: boolean,
  isFailed: boolean,
  isPulsing: boolean,
): string {
  if (isTerminal) return 'opacity-70';
  if (isFailed) return 'border-l-2 border-l-[#FF0033]';
  if (isPulsing) return 'border-l-2 animate-pulse-subtle';
  return '';
}

export default function TaskCard({
  issue,
  index,
  savedRepos,
  now,
  deleting,
  deletingPhase,
  actions,
}: {
  issue: IssueWithActiveStep;
  index: number;
  savedRepos: SavedRepo[] | null;
  now: number;
  deleting: boolean;
  deletingPhase?: IssueDeletingPhase;
  actions: CardActions;
}) {
  const isPulsing = PULSE_STATUSES.has(issue.status);
  const isTerminal = TERMINAL_STATUSES.has(issue.status);
  const isFailed = issue.status === TaskStatus.failed;
  const devPort = issue.dev_server_port ?? null;
  const accent = accentClass(isTerminal, isFailed, isPulsing);
  const cardClass = deleting
    ? 'border border-[#008F11]/20 p-3 transition-base pointer-events-none opacity-80'
    : `cursor-pointer border border-[#008F11]/20 p-3 transition-base hover:bg-[#00FF41]/5 ${accent}`;

  return (
    <div className={cardAnimation(index)}>
      <article
        className={cardClass}
        style={
          isPulsing && !deleting
            ? { borderLeftColor: statusColor[issue.status] }
            : undefined
        }
        aria-busy={deleting}
        onClick={deleting ? undefined : () => actions.open(issue.id)}
      >
        {deleting ? (
          <div
            data-testid="issue-deleting"
            className="flex items-center gap-2 p-4 text-sm italic text-gray-400"
          >
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[#00FF41]/30 border-t-[#00FF41]"
            />
            <span>Удаление...</span>
            {deletingPhase && (
              <span className="text-xs not-italic text-[#00FF41]/50">
                {DELETE_PHASE_LABELS[deletingPhase]}
              </span>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                {!NO_DOT_STATUSES.has(issue.status) && (
                  <span
                    aria-hidden="true"
                    className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                      isPulsing ? 'animate-pulse-subtle' : ''
                    }`}
                    style={{ backgroundColor: statusColor[issue.status] }}
                  />
                )}
                <span className="truncate font-medium text-[#00FF41]">
                  {issueKey(issue)}
                </span>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-0.5">
                <span
                  data-testid="issue-status"
                  data-status={issue.status}
                  className="text-xs transition-base"
                  style={{ color: statusColor[issue.status] }}
                >
                  {STATUS_LABELS[issue.status]}
                </span>
              </div>
            </div>

            <div className="mt-2 border-t border-[#008F11]/20 pt-2 text-xs text-[#00FF41]/80">
              <span className="block truncate">
                {repositoryNames(issue) || '—'}
              </span>
              {(issue.worker_count ?? 0) > 0 && (
                <span
                  data-testid="worker-count-badge"
                  className="mt-1 inline-flex items-center gap-1 text-[#00B4FF]"
                  title={`Макс. параллельных агентов: ${issue.worker_count}`}
                >
                  <ParallelIcon className="h-3.5 w-3.5" />
                  {issue.worker_count}
                </span>
              )}
              {issue.status === TaskStatus.running && issue.activeModel && (
                <span
                  data-testid="active-model-badge"
                  className="mt-1 ml-2 inline-flex items-center gap-1 text-[#00FF41]/70 text-[11px]"
                  title={`Текущая модель: ${issue.activeModel}`}
                >
                  {issue.activeModel}
                </span>
              )}
            </div>

            <div className="mt-2 border-t border-[#008F11]/20 pt-2">
              {showsRepoReadiness(issue) && (
                <RepoReadinessLine issue={issue} savedRepos={savedRepos} />
              )}
              {showsIssueStats(issue) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#00FF41]/60">
                  <IssueStats
                    issue={issue}
                    now={now}
                    activeStep={issue.activeStep}
                    activeModel={issue.activeModel}
                  />
                </div>
              )}
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="whitespace-nowrap text-xs text-[#00FF41]/60">
                  {formatRelativeTime(issue.created_at)}
                </span>
                <div className="flex min-w-0 items-center gap-2">
                  {devPort !== null && (
                    <span
                      data-testid="dev-server-port"
                      title="Порт dev-сервера"
                      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-xs text-[#00FF41]"
                    >
                      <span
                        aria-hidden="true"
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#00FF41] animate-pulse-subtle"
                      />
                      :{devPort}
                    </span>
                  )}
                  {devPort !== null && (
                    <button
                      type="button"
                      data-testid="stop-dev-servers"
                      aria-label={`Остановить dev-серверы ${issueKey(issue)}`}
                      title="Остановить dev-серверы"
                      className="inline-flex min-h-6 items-center justify-center rounded-none p-1 text-[#FF0033]/60 hover:text-[#FF0033] hover:bg-transparent focus-visible:text-[#FF0033] transition-base"
                      onClick={(event) => {
                        event.stopPropagation();
                        actions.stopDevServers(issue.id);
                      }}
                    >
                      <StopIcon className="h-4 w-4" />
                    </button>
                  )}
                  <span data-testid="result-cell" className="whitespace-nowrap">
                    {hasViewableResult(issue) ? (
                      <button
                        type="button"
                        aria-label={`Просмотреть отчёт ${issueKey(issue)}`}
                        title="Просмотреть отчёт"
                        className="rounded-none border border-[#008F11] px-2 py-1 text-xs text-[#00FF41] hover:bg-[#008F11]/20 transition-base"
                        onClick={(event) => {
                          event.stopPropagation();
                          actions.openResult(issue.id);
                        }}
                      >
                        Просмотр
                      </button>
                    ) : (
                      <span className="text-[#00FF41]/40">—</span>
                    )}
                  </span>
                  <button
                    type="button"
                    data-testid="delete-issue"
                    aria-label={`Удалить задачу ${issueKey(issue)}`}
                    title="Удалить задачу"
                    className="inline-flex min-h-6 items-center justify-center rounded-none p-1 text-[#FF0033]/50 hover:text-[#FF0033] hover:bg-transparent focus-visible:text-[#FF0033] transition-base"
                    onClick={(event) => {
                      event.stopPropagation();
                      actions.remove(issue.id);
                    }}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </article>
    </div>
  );
}