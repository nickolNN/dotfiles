import type { StepAgent } from '@issue-resolver/shared';
import { agentStatusColor } from '../../theme';
import { tabLabel } from './agents';

interface AgentTabListProps {
  agents: StepAgent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function AgentTabList({
  agents,
  selectedId,
  onSelect,
}: AgentTabListProps) {
  return (
    <div
      role="tablist"
      aria-label="Агенты шага"
      className="flex flex-wrap gap-1 border-b border-[#008F11]/40 pb-1"
    >
      {agents.map((agent) => {
        const isSelected = agent.id === selectedId;
        return (
          <button
            key={agent.id}
            type="button"
            role="tab"
            aria-selected={isSelected}
            data-testid="step-agent-tab"
            data-agent-id={agent.id}
            data-role={agent.role}
            data-selected={isSelected ? 'true' : 'false'}
            data-status={agent.status}
            onClick={() => onSelect(agent.id)}
            className={`flex items-center gap-1 border px-2 py-0.5 text-[10px] uppercase tracking-wider${
              isSelected
                ? ' border-[#00FF41] bg-[#003B00] text-[#00FF41]'
                : ' border-[#008F11] text-[#00FF41]/70 hover:border-[#00FF41] hover:text-[#00FF41]'
            }`}
          >
            <span>{tabLabel(agent)}</span>
            <span
              data-testid="step-agent-status"
              style={{ color: agentStatusColor[agent.status] }}
            >
              {agent.status}
            </span>
          </button>
        );
      })}
    </div>
  );
}