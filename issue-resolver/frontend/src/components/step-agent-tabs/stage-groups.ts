import type { StepAgent } from '@issue-resolver/shared';
import { computeStepTotals } from './agents';
import type { StageGroup } from './types';

function stageModels(stageAgents: StepAgent[]): string[] {
  const models: string[] = [];
  for (const agent of stageAgents) {
    const model = agent.stats?.model?.trim();
    if (model && !models.includes(model)) models.push(model);
  }
  return models;
}

function stageContextPercent(stageAgents: StepAgent[]): number | null {
  let contextPercent: number | null = null;
  for (const agent of stageAgents) {
    const percent = agent.stats?.contextUsage?.percent;
    if (typeof percent !== 'number' || !Number.isFinite(percent)) continue;
    contextPercent =
      contextPercent === null ? percent : Math.max(contextPercent, percent);
  }
  return contextPercent;
}

export function groupAgentsByStage(
  agents: StepAgent[],
  now: number,
): StageGroup[] {
  const byStage = new Map<number, StepAgent[]>();
  for (const agent of agents) {
    if (agent.stage == null) continue;
    const list = byStage.get(agent.stage);
    if (list) list.push(agent);
    else byStage.set(agent.stage, [agent]);
  }

  return [...byStage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stage, stageAgents]) => {
      const name =
        stageAgents.find((agent) => agent.stageName?.trim())?.stageName?.trim() ??
        `Этап ${stage}`;
      return {
        stage,
        name,
        ...computeStepTotals(stageAgents, now),
        models: stageModels(stageAgents),
        contextPercent: stageContextPercent(stageAgents),
      };
    });
}