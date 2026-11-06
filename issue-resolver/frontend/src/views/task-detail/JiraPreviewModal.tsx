import { extractIssueKeyFromUrl } from "@issue-resolver/shared";
import AgentMarkdown from "../../components/AgentMarkdown";
import ModalShell, { ModalLayout } from "../../components/ModalShell";

interface JiraPreviewModalProps {
  jiraUrl: string;
  loading: boolean;
  text: string | null;
  onClose: () => void;
}

export default function JiraPreviewModal({
  jiraUrl,
  loading,
  text,
  onClose,
}: JiraPreviewModalProps) {
  return (
    <ModalShell
      layout={ModalLayout.full}
      onClose={onClose}
      overlayTestId="jira-preview-modal"
      title={
        <h3 className="text-lg font-semibold text-[#00B4FF]">
          Jira: {extractIssueKeyFromUrl(jiraUrl)}
        </h3>
      }
      classes={{
        card: "border-[#00B4FF] bg-[#0D0208]",
        body: "overflow-y-auto px-2 py-4 sm:px-6",
      }}
    >
      {loading && (
        <p className="text-sm text-[#00FF41]/60">Загрузка…</p>
      )}
      {!loading && text !== null && (
        <div data-testid="jira-preview-markdown">
          <AgentMarkdown>{text}</AgentMarkdown>
        </div>
      )}
      {!loading && text === null && (
        <p className="text-sm text-[#FF0033]">
          Не удалось загрузить данные Jira
        </p>
      )}
    </ModalShell>
  );
}