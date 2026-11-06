import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseStepReport, type StepReport } from '@issue-resolver/shared';

const STEP_REPORT_FILE = '.issue-step-result.json';

export const stepReportContractPath = (workspaceHostDir: string): string =>
  join(workspaceHostDir, STEP_REPORT_FILE);

const SCREENSHOTS_DIR = 'screenshots';

export async function screenshotsDirOf(
  workspaceHostDir: string,
): Promise<string | undefined> {
  try {
    await stat(join(workspaceHostDir, SCREENSHOTS_DIR));
    return SCREENSHOTS_DIR;
  } catch {
    return undefined;
  }
}

async function stepReportCandidates(workspaceHostDir: string): Promise<string[]> {
  const rootFile = join(workspaceHostDir, STEP_REPORT_FILE);
  const repoFiles = await depthOneStepReportFiles(workspaceHostDir);
  return [rootFile, ...repoFiles];
}

async function depthOneStepReportFiles(
  workspaceHostDir: string,
): Promise<string[]> {
  try {
    const entries = await readdir(workspaceHostDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(workspaceHostDir, entry.name, STEP_REPORT_FILE));
  } catch {
    return [];
  }
}

export interface StepReportSource {
  report: StepReport;
  path: string;
}

export type StepReportMtimes = Map<string, number>;

export async function stepReportMtimes(
  workspaceHostDir: string,
): Promise<StepReportMtimes> {
  const mtimes = await Promise.all(
    (await stepReportCandidates(workspaceHostDir)).map(async (path) => {
      try {
        return [path, (await stat(path)).mtimeMs] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(mtimes.filter((entry) => entry !== null));
}

export async function readStepReportFile(
  workspaceHostDir: string,
  before: StepReportMtimes,
): Promise<StepReportSource | null> {
  const touched = await Promise.all(
    (await stepReportCandidates(workspaceHostDir)).map(async (path) => {
      try {
        const { mtimeMs } = await stat(path);
        if (mtimeMs <= (before.get(path) ?? Number.NEGATIVE_INFINITY)) return null;
        const report = parseStepReport(await readFile(path, 'utf8'));
        return report ? { report, path, mtimeMs } : null;
      } catch {
        return null;
      }
    }),
  );

  const fresh = touched.filter((entry) => entry !== null);
  if (fresh.length === 0) return null;

  const rootFile = join(workspaceHostDir, STEP_REPORT_FILE);
  const newestFirst = fresh.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const chosen =
    newestFirst.find((entry) => entry.path === rootFile) ?? newestFirst[0];
  return { report: chosen.report, path: chosen.path };
}