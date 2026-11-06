import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { readTextFileOrNull } from '../util/files';

export const DEV_SERVER_SCRIPT = 'DEV_SERVER.sh';
export const DEV_SERVER_PID_FILE = '.dev-server.pid';
export const DEV_SERVER_LOG_FILE = '.dev-server.log';

const INFRA_FILES = [
  'RUN_INSTRUCTIONS.md',
  DEV_SERVER_SCRIPT,
  DEV_SERVER_PID_FILE,
  DEV_SERVER_LOG_FILE,
];

const ENGINE_FILES = [
  '.issue-step-result.json',
  '.issue-worker-result-*.json',
  '.issue-stage-*.json',
];

const EXCLUDED_FROM_MR = [...INFRA_FILES, ...ENGINE_FILES];

export function excludeInfraFiles(workspaceDir: string, repoName: string): void {
  const excludePath = join(workspaceDir, repoName, '.git', 'info', 'exclude');
  try {
    const current = readTextFileOrNull(excludePath) ?? '';
    const known = new Set(current.split('\n'));
    const missing = EXCLUDED_FROM_MR.filter((name) => !known.has(`/${name}`));
    if (missing.length === 0) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    appendFileSync(
      excludePath,
      `${missing.map((name) => `/${name}`).join('\n')}\n`,
    );
  } catch (error) {
    console.error('failed to exclude infra files from git', error);
  }
}

function devServerPidPath(workspaceDir: string, repoName: string): string {
  return join(workspaceDir, repoName, DEV_SERVER_PID_FILE);
}

export function readDevServerPid(
  workspaceDir: string,
  repoName: string,
): number | null {
  const raw = readTextFileOrNull(devServerPidPath(workspaceDir, repoName));
  if (raw === null) return null;
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function writeDevServerPid(
  workspaceDir: string,
  repoName: string,
  pid: number,
): void {
  try {
    writeFileSync(devServerPidPath(workspaceDir, repoName), `${pid}\n`);
  } catch (error) {
    console.error('failed to write dev server pid file', error);
  }
}

export function clearDevServerPid(
  workspaceDir: string,
  repoName: string,
): void {
  rmSync(devServerPidPath(workspaceDir, repoName), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function devServerResponds(
  port: number,
  attempts = 1,
  delayMs = 500,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2000),
      });
      return true;
    } catch {
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  return false;
}

export function readDevServerLogTail(
  workspaceDir: string,
  repoName: string,
  lines = 6,
): string {
  const raw = readTextFileOrNull(
    join(workspaceDir, repoName, DEV_SERVER_LOG_FILE),
  );
  if (raw === null) return '';
  return raw.trim().split('\n').slice(-lines).join(' | ');
}

export function startRepoDevServer(
  workspaceDir: string,
  repoName: string,
  port: number,
): number | null {
  const repoDir = join(workspaceDir, repoName);
  const scriptPath = join(repoDir, DEV_SERVER_SCRIPT);
  clearDevServerPid(workspaceDir, repoName);
  if (!existsSync(scriptPath)) return null;
  try {
    const child = spawn(scriptPath, [], {
      cwd: repoDir,
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (error) => {
      console.error('failed to start DEV_SERVER.sh', error);
    });
    child.unref();
    if (child.pid) writeDevServerPid(workspaceDir, repoName, child.pid);
    return child.pid ?? null;
  } catch (error) {
    console.error('failed to spawn DEV_SERVER.sh', error);
    return null;
  }
}

export async function stopDevServerProcess(pid: number): Promise<void> {
  const tryKill = (target: number, sig: NodeJS.Signals): boolean => {
    try {
      process.kill(target, sig);
      return true;
    } catch {
      return false;
    }
  };
  const signal = (sig: NodeJS.Signals): void => {
    if (tryKill(-pid, sig)) return;
    tryKill(pid, sig);
  };

  signal('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  signal('SIGKILL');
}
