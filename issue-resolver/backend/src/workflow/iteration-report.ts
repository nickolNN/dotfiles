import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { StepRunWithLog } from '@issue-resolver/shared';
import {
  DEFAULT_WORKSPACE_ROOT,
  workspaceHostDirFor,
} from '../workspace/paths';
import { iterations } from '../db/schema';
import { listStepRunsWithLog } from '../db/step-runs.repo';
import type { Db } from '../db/client';
import { StepRunStatus, TaskStatus } from '@issue-resolver/shared';
import type { IterationRunDeps, RunIssueIterationInput } from './service-contracts';
import { nowIso } from '../db/rows';

function stepOutcome(run: StepRunWithLog): 'ok' | 'fail' | 'timeout' {
  if (run.status === StepRunStatus.success) {
    return 'ok';
  }
  const haystack = `${run.stderr}\n${run.report ?? ''}`.toLowerCase();
  if (haystack.includes('timeout') || haystack.includes('timed out')) {
    return 'timeout';
  }
  return 'fail';
}

export function renderIterationReport(params: {
  title: string;
  number: number;
  status: string;
  startedAt: string;
  finishedAt: string;
  runs: StepRunWithLog[];
}): string {
  const { title, number, status, startedAt, finishedAt, runs } = params;
  const lines: string[] = [
    `# Задача: ${title}`,
    `# Итерация #${number}`,
    '',
    `**Статус:** ${status}`,
    `**Начало:** ${startedAt}`,
    `**Конец:** ${finishedAt}`,
    '',
    '## Шаги',
    '',
  ];

  for (const run of runs) {
    if (run.report === null) {
      continue;
    }
    lines.push(
      `### ${run.step} (попытка ${run.attempt})`,
      '',
      `**Статус:** ${stepOutcome(run)}`,
      '',
      run.report,
      '',
      '---',
      '',
    );
  }

  return lines.join('\n');
}

export async function writeIterationReport(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
  status: TaskStatus,
): Promise<void> {
  try {
    const workspaceRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
    const workspaceHostDir = workspaceHostDirFor(workspaceRoot, input.issue.id);
    const runs = await listStepRunsWithLog(db, input.iteration.id);
    const row = db
      .select()
      .from(iterations)
      .where(eq(iterations.id, input.iteration.id))
      .get();
    const content = renderIterationReport({
      title: input.issue.title,
      number: input.iteration.number,
      status,
      startedAt: row?.created_at ?? '',
      finishedAt: row?.updated_at ?? nowIso(),
      runs,
    });
    mkdirSync(workspaceHostDir, { recursive: true });
    writeFileSync(
      join(workspaceHostDir, `report-${input.iteration.number}.md`),
      content,
      'utf8',
    );
  } catch (error) {
    console.error('failed to write iteration report', error);
  }
}
