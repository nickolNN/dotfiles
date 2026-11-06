import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_WORKSPACE_ROOT,
  workspaceHostDirFor,
} from '../workspace/paths';
import { issueSessionDir } from '../pi/session-paths';
import { nowIso } from '../db/rows';

const REPORT_ARTIFACTS = ['report.md', 'report.html'] as const;
const ARCHIVED_REPORT_FILES = [...REPORT_ARTIFACTS, 'report.json'] as const;

export interface ReportArchiveResult {
  dir: string | null;
  files: string[];
}

export function archiveReportSession(
  issueId: string,
  sessionId: string,
  targetDir: string,
): string[] {
  const dir = issueSessionDir(issueId);
  if (!dir || !existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => name.includes(sessionId));
  if (files.length === 0) return [];
  mkdirSync(targetDir, { recursive: true });
  for (const name of files) {
    copyFileSync(join(dir, name), join(targetDir, name));
    rmSync(join(dir, name), { force: true });
  }
  return files;
}

export function archiveReportArtifacts(
  workspaceRoot: string | undefined,
  issueId: string,
): ReportArchiveResult {
  const wsRoot = workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const issueDir = workspaceHostDirFor(wsRoot, issueId);
  const files = ARCHIVED_REPORT_FILES.filter((name) =>
    existsSync(join(issueDir, name)),
  );
  if (files.length === 0) return { dir: null, files: [] };

  const stamp = nowIso();
  let dir = join(issueDir, 'reports', stamp);
  for (let n = 1; existsSync(dir); n += 1) {
    dir = join(issueDir, 'reports', `${stamp}-${n}`);
  }
  mkdirSync(dir, { recursive: true });
  for (const name of files) {
    renameSync(join(issueDir, name), join(dir, name));
  }
  return { dir, files };
}

export function describeReportArtifacts(issueDir: string): string {
  return REPORT_ARTIFACTS.map((name) => {
    const path = join(issueDir, name);
    try {
      return `${path} (${statSync(path).size}B)`;
    } catch {
      return `${path} (absent)`;
    }
  }).join(', ');
}

export function reportArtifactsPresent(issueDir: string): {
  md: boolean;
  html: boolean;
} {
  const present = (name: string): boolean => {
    try {
      return statSync(join(issueDir, name)).size > 0;
    } catch {
      return false;
    }
  };
  return { md: present('report.md'), html: present('report.html') };
}
