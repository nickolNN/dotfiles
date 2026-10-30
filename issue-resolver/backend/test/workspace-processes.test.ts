import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  killWorkspaceProcesses,
  listWorkspaceProcesses,
  removeWorkspaceDir,
} from '../src/processes/workspace-processes';

const roots: string[] = [];
const children: ChildProcess[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ir-procs-'));
  roots.push(root);
  return root;
}

function spawnDetached(
  command: string,
  args: string[],
  cwd: string,
): ChildProcess {
  const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' });
  children.push(child);
  return child;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 3000,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-(child.pid as number), 'SIGKILL');
    } catch {
      // уже завершился
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('процессы рабочей папки задачи', () => {
  it('находит процесс с cwd в подкаталоге и убивает его группу', async () => {
    const ws = tempRoot();
    const repo = join(ws, 'repo');
    mkdirSync(repo, { recursive: true });
    const child = spawnDetached('sleep', ['60'], repo);
    await wait(200);

    const found = listWorkspaceProcesses(ws);
    const hit = found.find((entry) => entry.pid === child.pid);
    expect(hit?.reason).toBe('cwd');
    expect(hit?.cwd).toBe(repo);

    const { killed, remaining } = await killWorkspaceProcesses(ws);
    expect(killed).toContain(child.pid);
    expect(remaining).toEqual([]);
    expect(await waitForExit(child)).toBe(true);
  });

  it('находит процесс, у которого путь папки есть только в командной строке', async () => {
    const ws = tempRoot();
    const child = spawnDetached('sh', ['-c', 'sleep 60', ws], tmpdir());
    await wait(200);

    const found = listWorkspaceProcesses(ws);
    const hit = found.find((entry) => entry.pid === child.pid);
    expect(hit?.reason).toBe('cmdline');

    await killWorkspaceProcesses(ws);
    expect(await waitForExit(child)).toBe(true);
  });

  it('не трогает посторонние процессы', async () => {
    const ws = tempRoot();
    const other = tempRoot();
    const child = spawnDetached('sleep', ['60'], other);
    await wait(200);

    const found = listWorkspaceProcesses(ws);
    expect(found.map((entry) => entry.pid)).not.toContain(child.pid);
    expect(found.map((entry) => entry.pid)).not.toContain(process.pid);
  });

  it('removeWorkspaceDir убивает процессы и сносит папку', async () => {
    const ws = tempRoot();
    const repo = join(ws, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'index.html'), '<html></html>');
    const child = spawnDetached('sleep', ['60'], repo);
    await wait(200);

    const result = await removeWorkspaceDir(ws);

    expect(result.removed).toBe(true);
    expect(result.killed).toContain(child.pid);
    expect(existsSync(ws)).toBe(false);
    expect(await waitForExit(child)).toBe(true);
  });
});