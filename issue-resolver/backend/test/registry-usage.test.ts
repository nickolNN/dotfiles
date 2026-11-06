import { StepAgentRole } from '@issue-resolver/shared';
import type { SessionCost, SessionEvent, SessionStats } from '@issue-resolver/shared';
import { describe, expect, it } from 'vitest';
import {
  buildAgentStats,
  emptyAgentEntry,
  recordUsageEvent,
  type AgentEntry,
} from '../src/pi/registry/usage';

const newEntry = (): AgentEntry =>
  emptyAgentEntry('run-1', {
    role: StepAgentRole.worker,
    index: 0,
    label: 'worker',
  });

const ZERO_TOKENS = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

const statsWithCost = (cost: number): SessionStats => ({
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  tokens: ZERO_TOKENS,
  cost,
  contextUsage: null,
});

const cost = (total: number, fromProvider?: boolean): SessionCost => ({
  ...ZERO_TOKENS,
  total,
  ...(fromProvider === true ? { fromProvider: true } : {}),
});

const usageEvent = (
  total: number,
  spent: SessionCost | null,
): Extract<SessionEvent, { type: 'usage' }> => ({
  type: 'usage',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total },
  cost: spent,
});

describe('buildAgentStats — стоимость оплачена провайдером или оценена по каталогу', () => {
  it('два взноса с totalFromProvider → costFromProvider: true', () => {
    const entry = newEntry();
    recordUsageEvent(entry, usageEvent(10, cost(1, true)));
    recordUsageEvent(entry, usageEvent(5, cost(2, true)));

    expect(buildAgentStats(entry)?.costFromProvider).toBe(true);
    expect(buildAgentStats(entry)?.cost).toBe(3);
  });

  it('флаг, затем оценка → false и обратно не возвращается', () => {
    const entry = newEntry();
    recordUsageEvent(entry, usageEvent(10, cost(1, true)));
    recordUsageEvent(entry, usageEvent(5, cost(2)));
    recordUsageEvent(entry, usageEvent(4, cost(3, true)));

    expect(buildAgentStats(entry)?.costFromProvider).toBe(false);
  });

  it('оценка, затем флаг → false', () => {
    const entry = newEntry();
    recordUsageEvent(entry, usageEvent(10, cost(1)));
    recordUsageEvent(entry, usageEvent(5, cost(2, true)));

    expect(buildAgentStats(entry)?.costFromProvider).toBe(false);
  });

  it('без usage → ключа costFromProvider нет', () => {
    const entry = newEntry();
    expect(buildAgentStats(entry)).toBeNull();

    entry.lastStats = statsWithCost(0.5);
    expect(buildAgentStats(entry)).not.toHaveProperty('costFromProvider');
  });

  it('usage без cost не сбрасывает флаг', () => {
    const entry = newEntry();
    recordUsageEvent(entry, usageEvent(10, cost(1, true)));
    recordUsageEvent(entry, usageEvent(5, null));

    expect(buildAgentStats(entry)?.costFromProvider).toBe(true);
  });
});