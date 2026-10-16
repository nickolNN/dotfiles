import { describe, expect, it } from 'vitest';

import {
  parseSessionStats,
  parseStepReport,
  stepRunStatusFromResult,
  sumSessionStats,
} from '../src/step-result';
import type { SessionStats, StepReport } from '../src/types';

function stats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 2,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: null,
    contextUsage: null,
    ...overrides,
  };
}

describe('sumSessionStats', () => {
  it('суммирует токены, cost, сообщения и вызовы', () => {
    const total = sumSessionStats([
      stats({
        userMessages: 2,
        assistantMessages: 3,
        toolCalls: 5,
        toolResults: 4,
        totalMessages: 5,
        tokens: { input: 100, output: 40, cacheRead: 10, cacheWrite: 5, total: 155 },
        cost: 0.01,
      }),
      stats({
        tokens: { input: 200, output: 60, cacheRead: 20, cacheWrite: 7, total: 287 },
        cost: 0.02,
      }),
    ]);

    expect(total).toMatchObject({
      userMessages: 3,
      assistantMessages: 4,
      toolCalls: 6,
      toolResults: 5,
      totalMessages: 7,
      tokens: {
        input: 300,
        output: 100,
        cacheRead: 30,
        cacheWrite: 12,
        total: 442,
      },
      cost: 0.03,
      contextUsage: null,
    });
    // Модель/сессия — свойства конкретного агента, у суммы их нет.
    expect(total).not.toHaveProperty('model');
    expect(total).not.toHaveProperty('sessionId');
    expect(total).not.toHaveProperty('avgTokensPerSecond');
  });

  it('игнорирует null/undefined; cost null если нет ни одного значения', () => {
    const total = sumSessionStats([
      null,
      undefined,
      stats({ tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 } }),
    ]);

    expect(total).not.toBeNull();
    expect(total?.cost).toBeNull();
    expect(total?.tokens.input).toBe(7);
  });

  it('все элементы null/undefined → null', () => {
    expect(sumSessionStats([])).toBeNull();
    expect(sumSessionStats([null, undefined])).toBeNull();
  });
});

describe('parseStepReport', () => {
  it('parses a minimal valid report', () => {
    expect(parseStepReport('{"status":"pass","summary":"ok"}')).toEqual({
      status: 'pass',
      summary: 'ok',
    });
  });

  it('keeps pr_error (ошибка публикации MR/ветки) как строку', () => {
    const parsed = parseStepReport(
      JSON.stringify({
        status: 'pass',
        summary: 'PR готов',
        pr_error: 'https://github.com/acme/app.git — MR: 403',
      }),
    );

    expect(parsed?.status).toBe('pass');
    expect(parsed?.pr_error).toBe(
      'https://github.com/acme/app.git — MR: 403',
    );
  });

  it('omits a non-string pr_error', () => {
    const parsed = parseStepReport(
      JSON.stringify({ status: 'pass', summary: 'ok', pr_error: 42 }),
    );

    expect(parsed).not.toHaveProperty('pr_error');
  });

  it('keeps scenarios and findings arrays', () => {
    const parsed = parseStepReport(
      JSON.stringify({
        status: 'fail',
        summary: 'two failed',
        scenarios: [
          { name: 'login', status: 'pass' },
          { name: 'logout', status: 'fail', details: 'button missing' },
        ],
        findings: [
          { severity: 'major', description: 'flaky selector' },
          { severity: 'minor', description: 'typo' },
        ],
      }),
    );

    expect(parsed?.status).toBe('fail');
    expect(parsed?.summary).toBe('two failed');
    expect(parsed?.scenarios).toEqual([
      { name: 'login', status: 'pass' },
      { name: 'logout', status: 'fail', details: 'button missing' },
    ]);
    expect(parsed?.findings).toEqual([
      { severity: 'major', description: 'flaky selector' },
      { severity: 'minor', description: 'typo' },
    ]);
  });

  it('keeps both real-world forms of findings and scenarios', () => {
    const parsed = parseStepReport(
      JSON.stringify({
        status: 'fail',
        summary: 'mixed shapes',
        findings: [
          { severity: 'info', title: 'T', detail: 'D' },
          { severity: 'low', description: 'X' },
          { severity: 'minor', description: 'legacy' },
        ],
        scenarios: [
          { name: 'S', expected: 'E', actual: 'A' },
          { name: 'old', status: 'pass', details: 'fine' },
        ],
      }),
    );

    // (a) title/detail-форма без description сохранена.
    expect(parsed?.findings?.[0]).toEqual({
      severity: 'info',
      title: 'T',
      detail: 'D',
    });
    // (b) low + description сохранены.
    expect(parsed?.findings?.[1]).toEqual({
      severity: 'low',
      description: 'X',
    });
    // (c) expected/actual-форма без status сохранена, status отсутствует.
    expect(parsed?.scenarios?.[0]).toEqual({
      name: 'S',
      expected: 'E',
      actual: 'A',
    });
    expect(parsed?.scenarios?.[0]).not.toHaveProperty('status');
    // (d) старые формы finding/scenario не регрессируют.
    expect(parsed?.findings?.[2]).toEqual({
      severity: 'minor',
      description: 'legacy',
    });
    expect(parsed?.scenarios?.[1]).toEqual({
      name: 'old',
      status: 'pass',
      details: 'fine',
    });
  });

  it('keeps a valid execution plan', () => {
    const parsed = parseStepReport(
      JSON.stringify({
        status: 'pass',
        summary: 'ok',
        execution: {
          mode: 'room',
          executors: 2,
          decomposition: ['a', 'b'],
        },
      }),
    );

    expect(parsed?.execution).toEqual({
      mode: 'room',
      executors: 2,
      decomposition: ['a', 'b'],
    });
  });

  it('keeps a valid staged execution plan', () => {
    const parsed = parseStepReport(
      JSON.stringify({
        status: 'pass',
        summary: 'ok',
        execution: {
          mode: 'stages',
          stages: [
            { index: 1, name: 'Сбор', executors: 2, decomposition: ['a', 'b'] },
            { index: 2, task: 'починить' },
          ],
        },
      }),
    );

    expect(parsed?.execution).toEqual({
      mode: 'stages',
      stages: [
        { index: 1, name: 'Сбор', executors: 2, decomposition: ['a', 'b'] },
        { index: 2, task: 'починить' },
      ],
    });
  });

  it('omits execution when the field is absent', () => {
    expect(
      parseStepReport('{"status":"pass","summary":"ok"}'),
    ).not.toHaveProperty('execution');
  });

  it('omits a broken execution plan', () => {
    expect(
      parseStepReport(
        JSON.stringify({
          status: 'pass',
          summary: 'ok',
          execution: { mode: 'nope' },
        }),
      ),
    ).not.toHaveProperty('execution');
  });

  it('accepts blocked as a valid status', () => {
    expect(parseStepReport('{"status":"blocked","summary":"need creds"}')).toEqual({
      status: 'blocked',
      summary: 'need creds',
    });
  });

  it('returns null for non-JSON text', () => {
    expect(parseStepReport('not json')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseStepReport('')).toBeNull();
  });

  it('returns null for a JSON primitive', () => {
    expect(parseStepReport('42')).toBeNull();
  });

  it('returns null for an unknown status', () => {
    expect(parseStepReport('{"status":"nope"}')).toBeNull();
  });

  it('returns null when status is missing', () => {
    expect(parseStepReport('{"summary":"x"}')).toBeNull();
  });
});

describe('parseSessionStats', () => {
  it('normalizes a full get_session_stats payload', () => {
    expect(
      parseSessionStats({
        sessionFile: '/tmp/session.jsonl',
        sessionId: 's1',
        userMessages: 2,
        assistantMessages: 2,
        toolCalls: 3,
        toolResults: 3,
        totalMessages: 7,
        tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, total: 18 },
        cost: 0.5,
        contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
      }),
    ).toEqual({
      sessionId: 's1',
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 3,
      toolResults: 3,
      totalMessages: 7,
      tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, total: 18 },
      cost: 0.5,
      contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
    });
  });

  it('defaults missing numbers to 0 and missing contextUsage to null', () => {
    expect(parseSessionStats({ userMessages: 1 })).toEqual({
      userMessages: 1,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: null,
      contextUsage: null,
    });
  });

  it('keeps null tokens/percent after compaction', () => {
    const stats = parseSessionStats({
      contextUsage: { tokens: null, contextWindow: 200000, percent: null },
    });
    expect(stats?.contextUsage).toEqual({
      tokens: null,
      contextWindow: 200000,
      percent: null,
    });
  });

  it('returns null for non-object data', () => {
    expect(parseSessionStats(null)).toBeNull();
    expect(parseSessionStats('nope')).toBeNull();
    expect(parseSessionStats([1, 2])).toBeNull();
  });

  it('includes an explicit model label', () => {
    expect(parseSessionStats({ userMessages: 1 }, 'Claude Sonnet')?.model).toBe(
      'Claude Sonnet',
    );
  });

  it('omits model when neither arg nor obj.model is a non-empty string', () => {
    expect(parseSessionStats({ userMessages: 1 })).not.toHaveProperty('model');
  });

  it('explicit model arg wins over obj.model', () => {
    expect(
      parseSessionStats({ userMessages: 1, model: 'obj-model' }, 'arg-model')
        ?.model,
    ).toBe('arg-model');
  });

  it('falls back to a non-empty obj.model without an arg', () => {
    expect(parseSessionStats({ userMessages: 1, model: 'obj-model' })?.model).toBe(
      'obj-model',
    );
  });

  it('ignores blank/undefined model labels', () => {
    expect(
      parseSessionStats({ userMessages: 1, model: '   ' }, '  '),
    ).not.toHaveProperty('model');
    expect(
      parseSessionStats({ userMessages: 1, model: '' }, undefined),
    ).not.toHaveProperty('model');
    expect(parseSessionStats({ userMessages: 1 }, null)).not.toHaveProperty(
      'model',
    );
  });
});

describe('stepRunStatusFromResult', () => {
  const pass: StepReport = { status: 'pass', summary: 'ok' };
  const fail: StepReport = { status: 'fail', summary: 'bad' };
  const blocked: StepReport = { status: 'blocked', summary: 'hold' };

  it('maps exit 0 with no report to success', () => {
    expect(stepRunStatusFromResult(0, null)).toBe('success');
  });

  it('maps exit 0 with a pass report to success', () => {
    expect(stepRunStatusFromResult(0, pass)).toBe('success');
  });

  it('maps non-zero exit with a pass report to failed', () => {
    expect(stepRunStatusFromResult(1, pass)).toBe('failed');
  });

  it('maps exit 0 with a fail report to failed', () => {
    expect(stepRunStatusFromResult(0, fail)).toBe('failed');
  });

  it('maps exit 0 with a blocked report to needs_input', () => {
    expect(stepRunStatusFromResult(0, blocked)).toBe('needs_input');
  });

  it('maps a negative exit with no report to failed', () => {
    expect(stepRunStatusFromResult(-1, null)).toBe('failed');
  });
});