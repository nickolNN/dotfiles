import {
  FindingSeverity,
  StepRunStatus,
  StepReportStatus,
  ScenarioStatus,
  StepFailureReason,
  isFindingSeverity,
} from './status';
import type { SessionStats } from './types/session';
import type {
  StepReport,
  StepReportFinding,
  StepReportScenario,
} from './types/step';

import { parseExecutionPlan } from './execution';
import { num, numberOrNull } from './numbers';

const VALID_REPORT_STATUSES: readonly StepReportStatus[] = [
  StepReportStatus.pass,
  StepReportStatus.fail,
  StepReportStatus.blocked,
];

function isReportStatus(value: unknown): value is StepReportStatus {
  return (
    typeof value === 'string' &&
    VALID_REPORT_STATUSES.some((candidate) => candidate === value)
  );
}

const modelLabel = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

export function parseSessionStats(
  data: unknown,
  model?: string | null,
): SessionStats | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }

  const obj = data as Record<string, unknown>;
  const label = modelLabel(model) ?? modelLabel(obj.model);
  const tokens = (
    typeof obj.tokens === 'object' && obj.tokens !== null && !Array.isArray(obj.tokens)
      ? obj.tokens
      : {}
  ) as Record<string, unknown>;
  const rawContext = obj.contextUsage;
  const context =
    typeof rawContext === 'object' &&
    rawContext !== null &&
    !Array.isArray(rawContext)
      ? (rawContext as Record<string, unknown>)
      : null;

  return {
    ...(typeof obj.sessionId === 'string' ? { sessionId: obj.sessionId } : {}),
    ...(label !== null ? { model: label } : {}),
    userMessages: num(obj.userMessages),
    assistantMessages: num(obj.assistantMessages),
    toolCalls: num(obj.toolCalls),
    toolResults: num(obj.toolResults),
    totalMessages: num(obj.totalMessages),
    tokens: {
      input: num(tokens.input),
      output: num(tokens.output),
      cacheRead: num(tokens.cacheRead),
      cacheWrite: num(tokens.cacheWrite),
      total: num(tokens.total),
    },
    cost: numberOrNull(obj.cost),
    contextUsage: context
      ? {
          tokens: numberOrNull(context.tokens),
          contextWindow: num(context.contextWindow),
          percent: numberOrNull(context.percent),
        }
      : null,
  };
}

export function sumSessionStats(
  stats: readonly (SessionStats | null | undefined)[],
): SessionStats | null {
  const present = stats.filter((entry): entry is SessionStats => entry != null);
  if (present.length === 0) return null;

  const sum = (pick: (entry: SessionStats) => number): number =>
    present.reduce((acc, entry) => acc + pick(entry), 0);

  const costs = present
    .map((entry) => entry.cost)
    .filter((cost): cost is number => cost != null);

  return {
    userMessages: sum((entry) => entry.userMessages),
    assistantMessages: sum((entry) => entry.assistantMessages),
    toolCalls: sum((entry) => entry.toolCalls),
    toolResults: sum((entry) => entry.toolResults),
    totalMessages: sum((entry) => entry.totalMessages),
    tokens: {
      input: sum((entry) => entry.tokens.input),
      output: sum((entry) => entry.tokens.output),
      cacheRead: sum((entry) => entry.tokens.cacheRead),
      cacheWrite: sum((entry) => entry.tokens.cacheWrite),
      total: sum((entry) => entry.tokens.total),
    },
    cost: costs.length > 0 ? costs.reduce((acc, cost) => acc + cost, 0) : null,
    contextUsage: null,
  };
}

function reportRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scenarioOf(value: unknown): StepReportScenario | null {
  const raw = reportRecord(value);
  if (!raw || typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return null;
  }
  return {
    name: raw.name,
    ...(raw.status === ScenarioStatus.pass || raw.status === ScenarioStatus.fail
      ? { status: raw.status }
      : {}),
    ...(typeof raw.details === 'string' ? { details: raw.details } : {}),
    ...(typeof raw.expected === 'string' ? { expected: raw.expected } : {}),
    ...(typeof raw.actual === 'string' ? { actual: raw.actual } : {}),
  };
}

interface ParsedFinding {
  finding: StepReportFinding;
  malformed: boolean;
}

function findingOf(value: unknown): ParsedFinding | null {
  const raw = reportRecord(value);
  if (!raw) return null;
  const severity = raw.severity;
  const severityKnown = isFindingSeverity(severity);
  return {
    finding: {
      severity: isFindingSeverity(severity)
        ? severity
        : FindingSeverity.critical,
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
      ...(typeof raw.description === 'string'
        ? { description: raw.description }
        : {}),
      ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
    },
    malformed: !severityKnown,
  };
}

function findingsOf(raw: unknown[]): {
  findings: StepReportFinding[];
  malformed: boolean;
} {
  const parsed = raw
    .map(findingOf)
    .filter((item): item is ParsedFinding => item !== null);
  return {
    findings: parsed.map((item) => item.finding),
    malformed: parsed.some((item) => item.malformed),
  };
}

function reportItems<T>(
  raw: unknown[],
  parseOne: (value: unknown) => T | null,
): T[] {
  return raw.map(parseOne).filter((item): item is T => item !== null);
}

export function parseStepReport(json: string): StepReport | null {
  if (typeof json !== 'string') return null;

  const trimmed = json.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const status = obj.status;
  if (!isReportStatus(status)) {
    return null;
  }

  const execution = parseExecutionPlan(obj.execution);
  const executionMalformed =
    obj.execution !== undefined &&
    obj.execution !== null &&
    execution === null;
  const findings = Array.isArray(obj.findings)
    ? findingsOf(obj.findings)
    : null;

  return {
    status,
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    ...(typeof obj.title === 'string' ? { title: obj.title } : {}),
    ...(typeof obj.description === 'string'
      ? { description: obj.description }
      : {}),
    ...(typeof obj.pr_error === 'string' ? { pr_error: obj.pr_error } : {}),
    ...(Array.isArray(obj.merge_requests)
      ? {
          merge_requests: (obj.merge_requests as unknown[])
            .filter(
              (item): item is Record<string, unknown> =>
                typeof item === 'object' && item !== null,
            )
            .map((item) => ({
              repository_url:
                typeof item.repository_url === 'string'
                  ? item.repository_url
                  : '',
              title: typeof item.title === 'string' ? item.title : '',
              description:
                typeof item.description === 'string' ? item.description : '',
            }))
            .filter((entry) => entry.repository_url && entry.title),
        }
      : {}),
    ...(Array.isArray(obj.scenarios)
      ? { scenarios: reportItems(obj.scenarios, scenarioOf) }
      : {}),
    ...(Array.isArray(obj.findings) && findings !== null
      ? { findings: findings.findings }
      : {}),
    ...(findings?.malformed ? { findingsMalformed: true } : {}),
    ...(execution !== null ? { execution } : {}),
    ...(executionMalformed ? { executionMalformed } : {}),
  };
}

export type { StepFailureReason } from './status';

export interface StepRunOutcome {
  status: StepRunStatus;
  failure: StepFailureReason | null;
}

export interface StepRunOutcomeInput {
  exitCode: number;
  report: StepReport | null;
  modelReplied?: boolean;
  requiresStepReport?: boolean;
  aborted?: boolean;
}

export function stepRunOutcome(input: StepRunOutcomeInput): StepRunOutcome {
  if (input.aborted === true) {
    return { status: StepRunStatus.aborted, failure: null };
  }
  if (input.modelReplied === false) {
    return { status: StepRunStatus.failed, failure: StepFailureReason.no_model_reply };
  }
  if (input.exitCode !== 0) {
    return { status: StepRunStatus.failed, failure: StepFailureReason.agent_exit };
  }
  if (input.report === null) {
    return (input.requiresStepReport ?? true)
      ? { status: StepRunStatus.failed, failure: StepFailureReason.no_report }
      : { status: StepRunStatus.success, failure: null };
  }
  if (input.report.status === StepReportStatus.blocked) {
    return { status: StepRunStatus.needs_input, failure: null };
  }
  return input.report.status === ScenarioStatus.fail
    ? { status: StepRunStatus.failed, failure: StepFailureReason.report_fail }
    : { status: StepRunStatus.success, failure: null };
}

const BLOCKING_SEVERITIES: ReadonlySet<FindingSeverity> = new Set([
  FindingSeverity.major,
  FindingSeverity.critical,
]);

const NO_REPORT_FINDING: StepReportFinding = Object.freeze({
  severity: FindingSeverity.critical,
  title: 'step failed without a report',
  detail: 'There is no report to read, so the failure cannot be classified.',
});

const SILENT_FAILURE_FINDING: StepReportFinding = Object.freeze({
  severity: FindingSeverity.critical,
  title: 'failed without findings',
  detail:
    'The report says `fail` but names no defect; a silent failure is treated as blocking.',
});

/** A finding that sends the change back to development: `major`, `critical`,
 * or an unreadable severity, which sits on the safe side. */
export function isBlockingFinding(finding: StepReportFinding): boolean {
  const severity: unknown = finding.severity;
  return !isFindingSeverity(severity) || BLOCKING_SEVERITIES.has(severity);
}

/**
 * Findings that send the pipeline back to development. A `fail` without them
 * advances like a pass; `pass` is never overridden by a finding's severity.
 * Unreadable input sits on the safe side: a missing report, a `fail` with no
 * findings, a malformed severity or a `findingsMalformed` marker all block.
 */
export function blockingFindings(
  report: StepReport | null | undefined,
): StepReportFinding[] {
  if (report == null) return [NO_REPORT_FINDING];
  if (report.status !== StepReportStatus.fail) return [];
  const findings = report.findings ?? [];
  if (findings.length === 0) return [SILENT_FAILURE_FINDING];
  return report.findingsMalformed ? [...findings] : findings.filter(isBlockingFinding);
}