import { existsSync } from 'node:fs';
import path from 'node:path';
import type { GitContext } from './exec';
import { gitTimeoutMs } from './timeouts';
import { messageOf } from '../util/errors';

export interface InstallCommand {
  file: string;
  args: string[];
}

export function detectInstallCommand(repoPath: string): InstallCommand | null {
  if (existsSync(path.join(repoPath, 'package-lock.json'))) {
    return { file: 'npm', args: ['ci'] };
  }
  if (existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) {
    return { file: 'pnpm', args: ['install'] };
  }
  if (existsSync(path.join(repoPath, 'yarn.lock'))) {
    return { file: 'yarn', args: ['install'] };
  }
  if (
    existsSync(path.join(repoPath, 'bun.lock')) ||
    existsSync(path.join(repoPath, 'bun.lockb'))
  ) {
    return { file: 'bun', args: ['install'] };
  }
  if (existsSync(path.join(repoPath, 'package.json'))) {
    return { file: 'npm', args: ['install'] };
  }
  if (existsSync(path.join(repoPath, 'go.mod'))) {
    return { file: 'go', args: ['mod', 'download'] };
  }
  return null;
}

export async function installDependencies(
  ctx: GitContext,
  repoPaths: string[],
): Promise<void> {
  for (const repoPath of repoPaths) {
    const command = detectInstallCommand(repoPath);
    if (!command) {
      continue;
    }
    if (
      command.file !== 'go' &&
      existsSync(path.join(repoPath, 'node_modules'))
    ) {
      continue;
    }
    try {
      await ctx.exec(command.file, command.args, {
        cwd: repoPath,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        timeout: gitTimeoutMs(),
      });
    } catch (error) {
      const message = messageOf(error);
      throw new Error(
        `dependency install failed (${command.file} ${command.args.join(' ')}) in ${repoPath}: ${message}`,
      );
    }
  }
}