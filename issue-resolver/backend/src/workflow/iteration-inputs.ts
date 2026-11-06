import { readTextFileOrNullAsync } from '../util/files';
import { JSON_PARSE_FAILED, tryParseJson } from '../util/json-file';
import { asRecord } from '../util/records';
import { join } from 'node:path';
import {
  DEFAULT_WORKSPACE_ROOT,
  workspaceHostDirFor,
} from '../workspace/paths';
import { and, eq } from 'drizzle-orm';
import { iterations } from '../db/schema';
import { listStepRunsWithLog } from '../db/step-runs.repo';
import type { Db } from '../db/client';
import { extractIssueKeyFromUrl, PipelineStep } from '@issue-resolver/shared';
import type { DesiredResult } from '@issue-resolver/shared';
import type { IterationRunDeps, RunIssueIterationInput } from './service-contracts';

export async function fetchJiraText(
  workspaceRoot: string,
  issueId: string,
  jiraIssueUrl: string | null,
): Promise<string | null> {
  if (!jiraIssueUrl) return null;
  const key = extractIssueKeyFromUrl(jiraIssueUrl);
  if (!key) return null;
  const wsDir = workspaceHostDirFor(workspaceRoot, issueId);
  const mdPath = join(wsDir, 'jira', `${key}.md`);
  return readTextFileOrNullAsync(mdPath);
}

const MAX_PREVIOUS_OUTCOME_CHARS = 4000;

interface PreviousResolveSummary {
  status: string;
  summary: string;
}

function parseResolveReport(raw: string | null): PreviousResolveSummary | null {
  const parsed = tryParseJson(raw);
  if (parsed === JSON_PARSE_FAILED) return null;
  const report = asRecord(parsed);
  if (report === null) return null;
  return {
    status: typeof report.status === 'string' ? report.status : 'unknown',
    summary: typeof report.summary === 'string' ? report.summary : '',
  };
}

async function readResultDocument(
  workspaceRoot: string,
  issueId: string,
  _desiredResult?: DesiredResult,
): Promise<string | null> {
  const path = join(workspaceHostDirFor(workspaceRoot, issueId), 'report.md');
  return readTextFileOrNullAsync(path);
}


function documentPlaceholder(): string {
  return '(result document not found)';
}

function composePreviousOutcome(
  previousNumber: number,
  report: PreviousResolveSummary | null,
  document: string | null,
): string {
  const status = report?.status ?? 'unknown';
  const summary = report?.summary.trim() || '(no summary)';
  const documentNote =
    document !== null
      ? document.slice(0, MAX_PREVIOUS_OUTCOME_CHARS)
      : documentPlaceholder();

  return [
    `Previous iteration #${previousNumber} (status ${status}): ${summary}.`,
    'Result document:',
    documentNote,
  ].join('\n');
}

export async function buildPreviousOutcome(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
): Promise<string | undefined> {
  const currentNumber = input.iteration.number;
  if (currentNumber <= 1) {
    return undefined;
  }

  const previous = db
    .select()
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, input.iteration.issueId),
        eq(iterations.number, currentNumber - 1),
      ),
    )
    .get();
  if (!previous) {
    return undefined;
  }

  const runs = await listStepRunsWithLog(db, previous.id);
  const resolveRun = runs
    .filter((run) => run.step === PipelineStep.resolve)
    .at(-1);
  const report = parseResolveReport(resolveRun?.report ?? null);
  const document = await readResultDocument(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    input.issue.id,
  );

  return composePreviousOutcome(
    currentNumber - 1,
    report,
    document,
  );
}
