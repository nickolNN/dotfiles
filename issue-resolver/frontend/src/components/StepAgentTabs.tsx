import { StepAgentStatus } from '@issue-resolver/shared';
import AutoScrollBox from './AutoScrollBox';
import CollectionState from './CollectionState';
import SessionView from './SessionView';
import AgentTabList from './step-agent-tabs/AgentTabList';
import AgentTotals from './step-agent-tabs/AgentTotals';
import { tabLabel } from './step-agent-tabs/agents';
import { useStepAgentData } from './step-agent-tabs/useStepAgentData';
import type { StepAgentTabsProps } from './step-agent-tabs/types';

export default function StepAgentTabs({
  iterationId,
  eventsByAgent,
  statsByAgent,
  refreshKey = 0,
  statusPollMs = 3000,
  emptyMessage,
  emptyRetryMs = 1000,
  maxEmptyRetries = 5,
}: StepAgentTabsProps) {
  const {
    agentsState,
    selected,
    selectedId,
    selectAgent,
    selectedDuration,
    events,
    stepTotals,
    stageGroups,
  } = useStepAgentData({
    iterationId,
    eventsByAgent,
    refreshKey,
    statusPollMs,
    emptyRetryMs,
    maxEmptyRetries,
  });

  return (
    <CollectionState
      state={agentsState}
      loadingText="Загрузка агентов…"
      loadingTestId="step-agents-loading"
      loadingClassName="mt-2 text-xs text-[#00FF41]/60"
      renderError={(message) => (
        <p
          data-testid="step-agents-error"
          role="alert"
          className="mt-2 text-xs font-medium text-[#FF0033]"
        >
          Не удалось загрузить агентов: {message}
        </p>
      )}
      empty={
        <p
          data-testid="step-agents-empty"
          className="mt-2 text-xs text-[#00FF41]/60"
        >
          Агенты шага не найдены.
        </p>
      }
    >
      {(agents) => {
        if (!selected) return null;

        return (
          <div data-testid="step-agents" className="mt-2">
            <AgentTotals totals={stepTotals} stageGroups={stageGroups} />

            <AgentTabList
              agents={agents}
              selectedId={selectedId}
              onSelect={selectAgent}
            />

            {selectedDuration !== '' && (
              <p
                data-testid="step-agent-duration"
                className="mt-1 text-[10px] tracking-wider text-[#00FF41]/60"
              >
                ⏱ {tabLabel(selected)} · {selectedDuration}
              </p>
            )}

            <div data-testid="step-agent-session" data-agent-id={selected.id}>
              <AutoScrollBox
                scrollKey={events.length}
                className="mt-2 h-[300px] overflow-auto border border-[#008F11] bg-[#000200] p-2"
              >
                <SessionView
                  events={events}
                  stats={selected.stats ?? statsByAgent?.[selected.id] ?? null}
                  running={selected.status === StepAgentStatus.running}
                  showFooter
                  emptyMessage={emptyMessage}
                />
              </AutoScrollBox>
            </div>
          </div>
        );
      }}
    </CollectionState>
  );
}