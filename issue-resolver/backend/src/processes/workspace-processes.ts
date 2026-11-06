import { readdirSync, readlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { messageOf } from '../util/errors';
import { readTextFileOrNull } from '../util/files';

export type WorkspaceProcessReason = 'cwd' | 'cmdline' | 'fd';

export interface WorkspaceProcess {
  pid: number;
  pgid: number;
  cwd: string | null;
  reason: WorkspaceProcessReason;
}

const TERM_GRACE_MS = 700;
const REMOVE_ATTEMPTS = 4;
const REMOVE_RETRY_MS = 250;

function stripDeletedSuffix(path: string): string {
  return path.endsWith(' (deleted)')
    ? path.slice(0, -' (deleted)'.length)
    : path;
}

function isInside(path: string, wsPath: string): boolean {
  return path === wsPath || path.startsWith(`${wsPath}/`);
}

function readlinkQuiet(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function readCmdline(pid: number): string {
  return (readTextFileOrNull(`/proc/${pid}/cmdline`) ?? '')
    .split('\0')
    .join(' ');
}

function readPgid(pid: number): number | null {
  const stat = readTextFileOrNull(`/proc/${pid}/stat`);
  if (!stat) return null;
  const tail = stat.slice(stat.lastIndexOf(')') + 1).trim();
  const fields = tail.split(/\s+/);
  const pgid = Number.parseInt(fields[2] ?? '', 10);
  return Number.isInteger(pgid) ? pgid : null;
}

function readOpenFileLinks(pid: number): string[] {
  const fdDir = `/proc/${pid}/fd`;
  let entries: string[];
  try {
    entries = readdirSync(fdDir);
  } catch {
    return [];
  }
  const links: string[] = [];
  for (const entry of entries) {
    const target = readlinkQuiet(join(fdDir, entry));
    if (target) links.push(stripDeletedSuffix(target));
  }
  return links;
}

function selfAndAncestors(): Set<number> {
  const pids = new Set<number>();
  let pid = process.pid;
  while (pid > 1 && !pids.has(pid)) {
    pids.add(pid);
    const stat = readTextFileOrNull(`/proc/${pid}/stat`);
    if (!stat) break;
    const tail = stat.slice(stat.lastIndexOf(')') + 1).trim();
    pid = Number.parseInt(tail.split(/\s+/)[1] ?? '', 10);
  }
  pids.add(1);
  return pids;
}

export function listWorkspaceProcesses(wsPath: string): WorkspaceProcess[] {
  const skip = selfAndAncestors();
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }

  const found: WorkspaceProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    if (skip.has(pid)) continue;

    const cwd = readlinkQuiet(`/proc/${pid}/cwd`);
    const normalizedCwd = cwd ? stripDeletedSuffix(cwd) : null;
    let reason: WorkspaceProcessReason | null = null;

    if (normalizedCwd && isInside(normalizedCwd, wsPath)) {
      reason = 'cwd';
    } else if (readCmdline(pid).includes(wsPath)) {
      reason = 'cmdline';
    } else if (readOpenFileLinks(pid).some((link) => isInside(link, wsPath))) {
      reason = 'fd';
    }
    if (!reason) continue;

    const pgid = readPgid(pid);
    found.push({
      pid,
      pgid: pgid ?? pid,
      cwd: normalizedCwd,
      reason,
    });
  }
  return found;
}

function killQuietly(target: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}

function signal(target: number, sig: NodeJS.Signals): void {
  killQuietly(target, sig);
}

function myselfPgid(): number {
  return readPgid(process.pid) ?? process.pid;
}

function signalProcess(entry: WorkspaceProcess, sig: NodeJS.Signals): void {
  if (entry.pgid !== myselfPgid() && killQuietly(-entry.pgid, sig)) return;
  signal(entry.pid, sig);
}

export async function killWorkspaceProcesses(
  wsPath: string,
): Promise<{ killed: number[]; remaining: number[] }> {
  const first = listWorkspaceProcesses(wsPath);
  for (const entry of first) signalProcess(entry, 'SIGTERM');
  if (first.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, TERM_GRACE_MS));
  }

  const stubborn = listWorkspaceProcesses(wsPath);
  for (const entry of stubborn) signalProcess(entry, 'SIGKILL');
  if (stubborn.length === 0) {
    return { killed: first.map((entry) => entry.pid), remaining: [] };
  }

  await new Promise((resolve) => setTimeout(resolve, 200));
  return {
    killed: [
      ...new Set([
        ...first.map((entry) => entry.pid),
        ...stubborn.map((entry) => entry.pid),
      ]),
    ],
    remaining: listWorkspaceProcesses(wsPath).map((entry) => entry.pid),
  };
}

export async function removeWorkspaceDir(
  wsPath: string,
): Promise<{ killed: number[]; removed: boolean; remaining: number[] }> {
  const killed = new Set<number>();
  let lastError: unknown = null;
  let remaining: number[] = [];

  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt++) {
    const round = await killWorkspaceProcesses(wsPath);
    for (const pid of round.killed) killed.add(pid);
    remaining = round.remaining;
    try {
      await rm(wsPath, { recursive: true, force: true });
      return { killed: [...killed], removed: true, remaining: [] };
    } catch (error) {
      lastError = error;
      remaining = listWorkspaceProcesses(wsPath).map((entry) => entry.pid);
      await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_MS));
    }
  }

  const message = messageOf(lastError);
  console.error('remove workspace failed', {
    wsPath,
    remaining,
    error: message,
  });
  return { killed: [...killed], removed: false, remaining };
}