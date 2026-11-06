import type { RefObject } from "react";
import { StepRunStatus } from "@issue-resolver/shared";
import AgentMarkdown from "../../components/AgentMarkdown";
import ModalShell, { ModalLayout } from "../../components/ModalShell";
import SessionStatsBar from "../../components/SessionStatsBar";
import SessionView from "../../components/SessionView";
import StepReportView from "../../components/StepReportView";
import AgentComposer from "./AgentComposer";
import { stepStatusColor } from "../../theme";
import type { ChatDraftApi } from "./chat-drafts";
import type { StepLogIteration, StepLogTarget } from "./types";
import type { useAgentChat } from "./useAgentChat";

interface StepLogModalProps {
  target: StepLogTarget;
  iteration: StepLogIteration;
  chat: ReturnType<typeof useAgentChat>;
  draft: ChatDraftApi;
  onClose: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
}

const SECTION_HEADER =
  "mb-1 text-[10px] uppercase tracking-wider text-[#00FF41]/50";

export default function StepLogModal({
  target,
  iteration,
  chat,
  draft,
  onClose,
  scrollRef,
  onScroll,
}: StepLogModalProps) {
  return (
    <ModalShell
      layout={ModalLayout.full}
      dialogLabel={target.title}
      overlayTestId="step-log-modal"
      closeTestId="step-log-modal-close"
      onClose={onClose}
      title={<span className="text-[#00FF41]">{target.title}</span>}
      actions={
        <>
          {target.attempt > 1 && (
            <span className="text-[#00FF41]/60">попытка {target.attempt}</span>
          )}
          <span
            className="text-xs uppercase tracking-wider"
            style={{ color: stepStatusColor[target.status] }}
          >
            {target.status}
          </span>
        </>
      }
      classes={{
        card: "border-[#008F11] bg-[#0D0208]",
        body: "flex min-h-0 flex-1 flex-col",
      }}
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="step-log-scroll"
        className="min-h-0 flex-1 space-y-4 overflow-auto py-4 px-2 sm:px-4"
      >
        {target.events.length > 0 ? (
          <section>
            <h4 className={SECTION_HEADER}>session</h4>
            <div data-testid="modal-session">
              <SessionView
                events={target.events}
                stats={target.stats}
                showFooter={false}
                hideInfo={true}
                running={target.active}
                startedAt={target.startedAt}
                onRecallQueued={chat.recallQueued}
              />
            </div>
          </section>
        ) : (
          target.stdout.trim() !== "" && (
            <section>
              <h4 className={SECTION_HEADER}>stdout</h4>
              <div
                data-testid="modal-stdout"
                className="border border-[#008F11] bg-[#000200] p-2"
              >
                <AgentMarkdown>{target.stdout}</AgentMarkdown>
              </div>
            </section>
          )
        )}
        {target.stderr.trim() !== "" && (
          <section>
            <h4 className={SECTION_HEADER}>stderr</h4>
            <pre
              data-testid="modal-stderr"
              className="overflow-x-auto whitespace-pre-wrap break-words border border-[#008F11] bg-[#000200] p-2 font-mono text-xs text-[#FF0033]"
            >
              {target.stderr}
            </pre>
          </section>
        )}
        {target.report !== null && target.report.trim() !== "" && (
          <section>
            <h4 className={SECTION_HEADER}>report</h4>
            <div
              data-testid="modal-report"
              className="border border-[#008F11] bg-[#000200] p-2"
            >
              <StepReportView raw={target.report} />
            </div>
          </section>
        )}
      </div>

      {(target.active || target.status === StepRunStatus.needs_input) && (
        <AgentComposer
          target={target}
          iteration={iteration}
          chat={chat}
          draft={draft}
        />
      )}

      <SessionStatsBar
        events={target.events}
        stats={target.stats}
        className="shrink-0 border-t border-[#008F11] px-2 py-2 sm:px-4"
      />
    </ModalShell>
  );
}