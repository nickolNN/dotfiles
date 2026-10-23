import type {
  SessionStats,
  StepReport,
  StepReportFinding,
  StepReportScenario,
  StepReportStatus,
  StepRunStatus,
} from './types';
import { parseExecutionPlan } from './execution';

const VALID_REPORT_STATUSES: readonly StepReportStatus[] = [
  'pass',
  'fail',
  'blocked',
];

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const nullableNum = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const modelLabel = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

/**
 * Разбор `data` из ответа `get_session_stats` в нормализованный SessionStats.
 * Модель не входит в `get_session_stats` — её отдают вторым аргументом из
 * `get_state`; без аргумента берётся непустой `obj.model`, если он есть
 * (например, при чтении персистентных stats).
 */
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
    cost: nullableNum(obj.cost),
    contextUsage: context
      ? {
          tokens: nullableNum(context.tokens),
          contextWindow: num(context.contextWindow),
          percent: nullableNum(context.percent),
        }
      : null,
  };
}

/**
 * Суммирует статистику нескольких pi-агентов шага (исполнители + координаторы
 * room/stages) в один агрегат для `step_outputs.stats`. Модель/сессия
 * (`model`, `sessionId`, `avgTokensPerSecond`) и `contextUsage` у суммы не
 * задаются — это свойства конкретного агента, а не шага. `cost` суммируется
 * только по не-null значениям; если их нет — null. Все элементы null/undefined
 * → null (нет телеметрии).
 */
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

/**
 * Разбор `.issue-step-result.json`, который пишет шаг конвейера.
 * Возвращает null, если строка пустая, не JSON, не объект, без status
 * или с невалидным status. Поля scenarios/findings опциональны.
 */
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
  if (
    typeof status !== 'string' ||
    !VALID_REPORT_STATUSES.includes(status as StepReportStatus)
  ) {
    return null;
  }

  return {
    status: status as StepReportStatus,
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
      ? { scenarios: obj.scenarios as StepReportScenario[] }
      : {}),
    ...(Array.isArray(obj.findings)
      ? { findings: obj.findings as StepReportFinding[] }
      : {}),
    ...(parseExecutionPlan(obj.execution)
      ? { execution: parseExecutionPlan(obj.execution) as import('./types').ExecutionPlan }
      : {}),
  };
}

/**
 * Маппинг сырого результата шага в StepRunStatus:
 * - exit 0 + blocked → needs_input
 * - exit 0 + (нет отчёта или pass) → success
 * - иначе (ненулевой exit, fail или отчёт без валидного pass) → failed
 */
export function stepRunStatusFromResult(
  exitCode: number,
  report: StepReport | null,
): StepRunStatus {
  if (exitCode === 0) {
    if (report?.status === 'blocked') return 'needs_input';
    if (report === null || report.status === 'pass') return 'success';
  }
  return 'failed';
}