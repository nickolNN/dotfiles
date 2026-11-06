import type { RefObject } from "react";
import type { WorkspaceFile } from "@issue-resolver/shared";
import ArtifactsModal from "../../components/ArtifactsModal";
import JiraPreviewModal from "./JiraPreviewModal";
import ResultModal from "./ResultModal";
import StepLogModal from "./StepLogModal";
import type { ArtifactMeta, LoadState, StepLogTarget } from "./types";
import type { ChatDraftApi } from "./chat-drafts";
import type { useAgentChat } from "./useAgentChat";
import { AsyncStateStatus } from '../../lib/async-state';

interface TaskDetailModalsProps {
  state: LoadState;
  result: {
    open: boolean;
    available: boolean;
    ready: boolean;
    artifactMeta: ArtifactMeta | null;
    markdown: string | null;
    onClose: () => void;
  };
  jira: {
    open: boolean;
    loading: boolean;
    text: string | null;
    onClose: () => void;
  };
  artifacts: {
    open: boolean;
    files: WorkspaceFile[];
    archiveUrl: string;
    onClose: () => void;
  };
  agent: {
    target: StepLogTarget | null;
    iterationId: string | null;
    aborting: boolean;
    abortError: string | null;
    onAbort: (iterationId: string) => void;
    onClose: () => void;
    chat: ReturnType<typeof useAgentChat>;
    draft: ChatDraftApi;
    scrollRef: RefObject<HTMLDivElement | null>;
    onScroll: () => void;
  };
}

export default function TaskDetailModals({
  state,
  result,
  jira,
  artifacts,
  agent,
}: TaskDetailModalsProps) {
  return (
    <>
      {result.open && state.status === AsyncStateStatus.ready && result.available && (
        <ResultModal
          issueId={state.data.issue.id}
          resultReady={result.ready}
          artifactMeta={result.artifactMeta}
          markdown={result.markdown}
          onClose={result.onClose}
        />
      )}

      {jira.open && state.status === AsyncStateStatus.ready && (
        <JiraPreviewModal
          jiraUrl={state.data.issue.jira_issue_url ?? ""}
          loading={jira.loading}
          text={jira.text}
          onClose={jira.onClose}
        />
      )}

      {state.status === AsyncStateStatus.ready && (
        <ArtifactsModal
          issueId={state.data.issue.id}
          files={artifacts.files}
          open={artifacts.open}
          onClose={artifacts.onClose}
          archiveUrl={artifacts.archiveUrl}
        />
      )}

      {agent.target && (
        <StepLogModal
          target={agent.target}
          iteration={{
            id: agent.iterationId,
            aborting: agent.aborting,
            abortError: agent.abortError,
            onAbort: agent.onAbort,
          }}
          chat={agent.chat}
          draft={agent.draft}
          onClose={agent.onClose}
          scrollRef={agent.scrollRef}
          onScroll={agent.onScroll}
        />
      )}
    </>
  );
}