import type { ReactNode } from "react";
import { API_BASE } from "../../api/client";
import AgentMarkdown from "../../components/AgentMarkdown";
import ModalShell, { ModalLayout } from "../../components/ModalShell";
import { RESULT_HTML_FILENAME, RESULT_MD_FILENAME } from "./constants";
import type { ArtifactMeta } from "./types";

interface ResultModalProps {
  issueId: string;
  resultReady: boolean;
  artifactMeta: ArtifactMeta | null;
  markdown: string | null;
  onClose: () => void;
}

const DOWNLOAD_CLASS = (ready: boolean): string =>
  `inline-flex items-center rounded-none border border-[#008F11] px-2 py-0.5 text-[11px] font-medium transition-base ${
    ready
      ? "text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41]"
      : "cursor-not-allowed text-[#00FF41]/40 opacity-40"
  }`;

export default function ResultModal({
  issueId,
  resultReady,
  artifactMeta,
  markdown,
  onClose,
}: ResultModalProps) {
  let body: ReactNode;
  if (artifactMeta?.status === 404) {
    body = (
      <div
        data-testid="result-missing"
        className="border border-[#008F11] p-4 text-sm text-[#00FF41]"
      >
        Отчёт ещё не сгенерирован. Нажмите «🔄 Обновить», чтобы запустить
        report-агента.
      </div>
    );
  } else if (
    artifactMeta &&
    !artifactMeta.contentType.includes("text/html")
  ) {
    body = (
      <div data-testid="result-not-html" className="text-sm text-[#00FF41]">
        <p className="mb-3 border border-[#008F11] p-2 text-[11px] text-[#00FF41]/70">
          HTML-версия отчёта недоступна — показан markdown.
        </p>
        {markdown === null ? (
          <p className="border border-[#008F11] p-4">Загрузка отчёта…</p>
        ) : (
          <div
            data-testid="result-markdown"
            className="border border-[#008F11] p-4"
          >
            <AgentMarkdown>{markdown}</AgentMarkdown>
          </div>
        )}
      </div>
    );
  } else {
    body = (
      <iframe
        data-testid="result-html"
        src={`${API_BASE}/issues/${issueId}/result`}
        title="Отчёт"
        sandbox="allow-scripts allow-popups"
        referrerPolicy="no-referrer"
        className="h-full w-full border border-[#008F11] bg-white"
      />
    );
  }

  return (
    <ModalShell
      layout={ModalLayout.full}
      dialogLabel="Отчёт"
      overlayTestId="result-modal"
      closeTestId="result-modal-close"
      onClose={onClose}
      title={<span className="text-[#00FF41]">Отчёт</span>}
      actions={
        <>
          {artifactMeta?.source === "iteration-snapshot" && (
            <span
              data-testid="artifact-source-badge"
              className="border border-[#008F11] px-2 py-0.5 text-[11px] text-[#00FF41]"
            >
              Показана предыдущая версия
              {artifactMeta.mtime ? ` от ${artifactMeta.mtime}` : ""} — новый
              отчёт ещё не готов.
            </span>
          )}
          <a
            data-testid="result-modal-download"
            href={`${API_BASE}/issues/${issueId}/result/download`}
            download={RESULT_HTML_FILENAME}
            aria-disabled={resultReady ? undefined : true}
            tabIndex={resultReady ? undefined : -1}
            onClick={(event) => {
              if (!resultReady) event.preventDefault();
            }}
            className={DOWNLOAD_CLASS(resultReady)}
          >
            Скачать HTML
          </a>
          <a
            data-testid="result-modal-download-md"
            href={`${API_BASE}/issues/${issueId}/result/md/download`}
            download={RESULT_MD_FILENAME}
            aria-disabled={resultReady ? undefined : true}
            tabIndex={resultReady ? undefined : -1}
            onClick={(event) => {
              if (!resultReady) event.preventDefault();
            }}
            className={DOWNLOAD_CLASS(resultReady)}
          >
            Скачать .md
          </a>
        </>
      }
      classes={{
        card: "border-[#008F11] bg-[#0D0208]",
        body: "min-h-0 flex-1 overflow-auto py-4 px-2 sm:px-4",
      }}
    >
      {body}
    </ModalShell>
  );
}