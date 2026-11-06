import type { IssueRepository, Iteration } from "@issue-resolver/shared";
import StopIcon from "../../components/icons/StopIcon";
import { RepoPrepStatus } from "../repoPrep";
import { REPO_PREP_COLORS, REPO_PREP_LABELS, REPO_PREP_MARKS } from "../repoPrep";

interface RepositoryRow {
  repository: IssueRepository;
  fullName: string;
  status: RepoPrepStatus;
  devPort: number | undefined;
}

interface MrLink {
  url: string;
  repositoryUrl: string;
}

interface RepositoryStatusPanelProps {
  rows: RepositoryRow[];
  mrItems: MrLink[];
  reviewIteration: Iteration | null;
  fetchingReviewId: string | null;
  stoppingDevServers: boolean;
  error: string | null;
  message: string | null;
  actions: {
    onFetchReview: (iteration: Iteration) => void;
    onStopDevServers: () => void;
    onCopyDevPort: (port: number) => void;
  };
}

export default function RepositoryStatusPanel({
  rows,
  mrItems,
  reviewIteration,
  fetchingReviewId,
  stoppingDevServers,
  error,
  message,
  actions,
}: RepositoryStatusPanelProps) {
  const {
    onFetchReview: handleFetchReview,
    onStopDevServers: handleStopDevServers,
    onCopyDevPort: copyDevServerPort,
  } = actions;
  return (
    <div
      data-testid="repo-status"
      className="mt-3 border border-[#008F11] bg-[#002B00]/30 px-3 py-2"
    >
      <h4 className="mb-1 text-xs uppercase tracking-wider text-[#00FF41]/60">
        Репозитории
      </h4>
      <ul className="space-y-1">
        {rows.map(
          ({ repository, fullName, status, devPort }) => (
            <li
              key={repository.id}
              data-testid="repo-status-row"
              data-repo={fullName}
              data-status={status}
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <span
                data-testid="repo-status-dot"
                data-status={status}
                role="img"
                aria-label={REPO_PREP_LABELS[status]}
                title={REPO_PREP_LABELS[status]}
                className="transition-base"
                style={{ color: REPO_PREP_COLORS[status] }}
              >
                {REPO_PREP_MARKS[status]}
              </span>
              <span className="text-[#00FF41]">{fullName}</span>
              <span className="text-[#00FF41]/50">
                {repository.branch_name}
              </span>
              <span className="text-[#00FF41]/50">
                {REPO_PREP_LABELS[status]}
              </span>
              {status === RepoPrepStatus.ready && devPort !== undefined && (
                <span className="inline-flex items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="repo-dev-port"
                    title={`Скопировать порт ${devPort}`}
                    aria-label={`Скопировать порт dev-сервера ${devPort}`}
                    onClick={() =>
                      void copyDevServerPort(devPort)
                    }
                    className="text-[#00B4FF] hover:text-[#00FF41] transition-base"
                  >
                    Dev: localhost:{devPort}
                  </button>
                  <button
                    type="button"
                    data-testid="repo-stop-dev"
                    disabled={stoppingDevServers}
                    onClick={() => void handleStopDevServers()}
                    title="Остановить dev-серверы"
                    aria-label="Остановить dev-серверы"
                    className="text-[#FF0033] hover:text-[#FF5555] disabled:opacity-40 transition-base"
                  >
                    <StopIcon className="h-3 w-3" />
                  </button>
                </span>
              )}
              {repository.create_mr &&
                (() => {
                  const mrMatch = mrItems.find(
                    (item) =>
                      item.repositoryUrl ===
                      repository.repository_url,
                  );
                  if (mrMatch) {
                    return (
                      <>
                        <a
                          data-testid="repo-mr-link"
                          href={mrMatch.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          title={mrMatch.url}
                          className="border border-[#00B4FF] px-1 py-0.5 text-[10px] text-[#00B4FF] no-underline hover:bg-[#00B4FF] hover:text-[#0D0208] transition-base"
                        >
                          MR
                        </a>
                        {reviewIteration && (
                          <button
                            type="button"
                            data-testid="fetch-review"
                            title="Результаты ревью MR"
                            disabled={
                              fetchingReviewId ===
                              reviewIteration.id
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleFetchReview(
                                reviewIteration,
                              );
                            }}
                            className="border border-[#00B4FF] bg-[#001018] px-1 py-0.5 text-[10px] text-[#00B4FF] hover:bg-[#00B4FF] hover:text-[#0D0208] disabled:opacity-50 transition-base"
                          >
                            {fetchingReviewId ===
                            reviewIteration.id
                              ? "Загружаем…"
                              : "📋 Ревью"}
                          </button>
                        )}
                      </>
                    );
                  }
                  return (
                    <span
                      data-testid="repo-mr-badge"
                      className="border border-[#555] px-1 py-0.5 text-[10px] text-[#555]"
                    >
                      MR
                    </span>
                  );
                })()}
              {repository.bootstrap_enabled === false && (
                <span className="text-[#FFB000]">
                  (запуск отключён)
                </span>
              )}
            </li>
          ),
        )}
      </ul>
      {error && (
        <p
          role="alert"
          data-testid="fetch-review-error"
          className="mt-2 text-xs font-medium text-[#FF0033]"
        >
          {error}
        </p>
      )}
      {message && (
        <p
          role="status"
          data-testid="fetch-review-message"
          className="mt-2 text-xs font-medium text-[#00FF41]"
        >
          {message}
        </p>
      )}
    </div>
  );
}
