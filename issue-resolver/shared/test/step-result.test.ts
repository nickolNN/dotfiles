import { describe, expect, it } from 'vitest';

import {
  blockingFindings,
  parseSessionStats,
  parseStepReport,
  stepRunOutcome,
  sumSessionStats,
} from '../src/step-result';
import type { SessionStats, StepReport, StepReportFinding } from '../src/types';

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

    expect(parsed?.findings?.[0]).toEqual({
      severity: 'info',
      title: 'T',
      detail: 'D',
    });
    expect(parsed?.findings?.[1]).toEqual({
      severity: 'low',
      description: 'X',
    });
    expect(parsed?.scenarios?.[0]).toEqual({
      name: 'S',
      expected: 'E',
      actual: 'A',
    });
    expect(parsed?.scenarios?.[0]).not.toHaveProperty('status');
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

  it('treats the retired room mode as an unreadable execution plan', () => {
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

    expect(parsed).not.toHaveProperty('execution');
    expect(parsed?.executionMalformed).toBe(true);
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
    const parsed = parseStepReport('{"status":"pass","summary":"ok"}');

    expect(parsed).not.toHaveProperty('execution');
    expect(parsed).not.toHaveProperty('executionMalformed');
  });

  it('marks a present but unreadable execution plan instead of hiding it', () => {
    const parsed = parseStepReport(
      JSON.stringify({
        status: 'pass',
        summary: 'ok',
        execution: { mode: 'nope' },
      }),
    );

    expect(parsed).not.toHaveProperty('execution');
    expect(parsed?.executionMalformed).toBe(true);
  });

  it('treats an explicit null execution as absent, not as unreadable', () => {
    const parsed = parseStepReport(
      JSON.stringify({ status: 'pass', summary: 'ok', execution: null }),
    );

    expect(parsed).not.toHaveProperty('execution');
    expect(parsed).not.toHaveProperty('executionMalformed');
  });

  it('drops non-object findings, marks unreadable severities and keeps the rest', () => {
    const parsed = parseStepReport(
      JSON.stringify({
        status: 'pass',
        summary: 'ok',
        scenarios: [null, 42, {}, { name: '  ' }, { name: 'ok', status: 'pass' }],
        findings: [
          null,
          { title: 'no severity' },
          { severity: 42, title: 'not a string' },
          { severity: 'critical', title: 'real' },
        ],
      }),
    );

    expect(parsed?.scenarios).toEqual([{ name: 'ok', status: 'pass' }]);
    expect(parsed?.findings).toEqual([
      { severity: 'critical', title: 'no severity' },
      { severity: 'critical', title: 'not a string' },
      { severity: 'critical', title: 'real' },
    ]);
    expect(parsed?.findingsMalformed).toBe(true);
  });

  it('keeps a finding with an unknown severity as blocking instead of dropping it', () => {
    const parsed = parseStepReport(
      JSON.stringify({
        status: 'fail',
        summary: 'bad',
        findings: [{ severity: 'high', title: 'unknown grade' }],
      }),
    );

    expect(parsed?.findings).toEqual([
      { severity: 'critical', title: 'unknown grade' },
    ]);
    expect(parsed?.findingsMalformed).toBe(true);
  });

  it('keeps every valid finding and scenario', () => {
    const parsed = parseStepReport(
      JSON.stringify({
        status: 'pass',
        summary: 'ok',
        scenarios: [{ name: 's', status: 'fail', details: 'd' }],
        findings: [{ severity: 'minor' }],
      }),
    );

    expect(parsed?.scenarios).toEqual([
      { name: 's', status: 'fail', details: 'd' },
    ]);
    expect(parsed?.findings).toEqual([{ severity: 'minor' }]);
    expect(parsed).not.toHaveProperty('findingsMalformed');
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

describe('stepRunOutcome', () => {
  const pass: StepReport = { status: 'pass', summary: 'ok' };
  const fail: StepReport = { status: 'fail', summary: 'bad' };
  const blocked: StepReport = { status: 'blocked', summary: 'hold' };

  it('maps exit 0 with a pass report to success', () => {
    expect(stepRunOutcome({ exitCode: 0, report: pass })).toEqual({
      status: 'success',
      failure: null,
    });
  });

  it('maps a silent exit 0 without a report to failed/no_report', () => {
    expect(stepRunOutcome({ exitCode: 0, report: null })).toEqual({
      status: 'failed',
      failure: 'no_report',
    });
  });

  it('maps a negative exit without a report to failed/agent_exit', () => {
    expect(stepRunOutcome({ exitCode: -1, report: null })).toEqual({
      status: 'failed',
      failure: 'agent_exit',
    });
  });

  it('maps non-zero exit with a pass report to failed/agent_exit', () => {
    expect(stepRunOutcome({ exitCode: 1, report: pass })).toEqual({
      status: 'failed',
      failure: 'agent_exit',
    });
  });

  it('maps exit 0 with a fail report to failed/report_fail', () => {
    expect(stepRunOutcome({ exitCode: 0, report: fail })).toEqual({
      status: 'failed',
      failure: 'report_fail',
    });
  });

  it('maps exit 0 with a blocked report to needs_input', () => {
    expect(stepRunOutcome({ exitCode: 0, report: blocked })).toEqual({
      status: 'needs_input',
      failure: null,
    });
  });

  it('keeps a blocked report failed when the agent exited non-zero', () => {
    expect(stepRunOutcome({ exitCode: 1, report: blocked })).toEqual({
      status: 'failed',
      failure: 'agent_exit',
    });
  });

  it('accepts a run without a step report only when it does not require one', () => {
    expect(
      stepRunOutcome({ exitCode: 0, report: null, requiresStepReport: false }),
    ).toEqual({ status: 'success', failure: null });
    expect(
      stepRunOutcome({ exitCode: 1, report: null, requiresStepReport: false }),
    ).toEqual({ status: 'failed', failure: 'agent_exit' });
  });

  it('fails a run whose model never replied, whatever the exit code', () => {
    const silent = { exitCode: 0, report: null, modelReplied: false };
    expect(stepRunOutcome(silent)).toEqual({
      status: 'failed',
      failure: 'no_model_reply',
    });
    expect(
      stepRunOutcome({ ...silent, exitCode: 1, report: pass }),
    ).toEqual({ status: 'failed', failure: 'no_model_reply' });
  });

  it('does not trust a pass report when the model never replied', () => {
    expect(
      stepRunOutcome({ exitCode: 0, report: pass, modelReplied: false }),
    ).toEqual({ status: 'failed', failure: 'no_model_reply' });
  });

  it('aborted важнее всего остального: прогон не становится success или failed', () => {
    expect(
      stepRunOutcome({
        exitCode: 0,
        report: pass,
        modelReplied: false,
        aborted: true,
      }),
    ).toEqual({ status: 'aborted', failure: null });
    expect(
      stepRunOutcome({ exitCode: 1, report: fail, aborted: true }),
    ).toEqual({ status: 'aborted', failure: null });
  });

  it('aborted: false не меняет решения по остальным признакам', () => {
    expect(
      stepRunOutcome({ exitCode: 0, report: pass, aborted: false }),
    ).toEqual({ status: 'success', failure: null });
  });

  it('treats an unknown model reply as unknown, not as silence', () => {
    expect(
      stepRunOutcome({ exitCode: 0, report: pass, modelReplied: undefined }),
    ).toEqual({ status: 'success', failure: null });
  });
});

describe('blockingFindings', () => {
  const report = (patch: Partial<StepReport>): StepReport => ({
    status: 'fail',
    summary: 'review found defects',
    ...patch,
  });

  it('returns major and critical findings only', () => {
    expect(
      blockingFindings(
        report({
          findings: [
            { severity: 'minor', title: 'typo' },
            { severity: 'major', title: 'wrong focus' },
            { severity: 'critical', title: 'crash' },
            { severity: 'info', title: 'observation' },
          ],
        }),
      ).map((finding) => finding.severity),
    ).toEqual(['major', 'critical']);
  });

  it('returns nothing for a fail with only non-blocking findings', () => {
    expect(
      blockingFindings(
        report({ findings: [{ severity: 'minor', title: 'typo' }] }),
      ),
    ).toEqual([]);
  });

  it('treats a fail without findings as one silent blocking finding', () => {
    const blockers = blockingFindings(report({}));

    expect(blockers).toHaveLength(1);
    expect(blockers[0].severity).toBe('critical');
  });

  it('treats an unreadable severity as blocking', () => {
    const malformed = report({
      findings: [{ severity: 'high' } as unknown as StepReportFinding],
    });

    expect(blockingFindings(malformed)).toHaveLength(1);
  });

  it('treats the findingsMalformed marker as blocking', () => {
    const malformed = report({
      findings: [{ severity: 'minor', title: 'typo' }],
      findingsMalformed: true,
    });

    expect(blockingFindings(malformed)).toHaveLength(1);
  });

  it('treats a missing report as blocking', () => {
    expect(blockingFindings(null)[0].severity).toBe('critical');
    expect(blockingFindings(undefined)[0].severity).toBe('critical');
  });

  it('lets pass win over a major finding', () => {
    expect(
      blockingFindings(
        report({
          status: 'pass',
          findings: [{ severity: 'major', title: 'remark' }],
        }),
      ),
    ).toEqual([]);
  });
});