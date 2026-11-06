import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { messageOf } from '../util/errors';

const execFileAsync = promisify(execFile);

export interface GitExecOptions {
  cwd?: string;
  maxBuffer: number;
  windowsHide: boolean;
  timeout: number;
}

export type GitExecFile = (
  file: string,
  args: string[],
  options: GitExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

export const defaultGitExecFile: GitExecFile = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, options);
  return { stdout: String(stdout), stderr: String(stderr) };
};

export function maskCredentialArgs(args: string[]): string[] {
  return args.map((arg) =>
    arg.startsWith('credential.helper=')
      ? arg.replace(/password=[^;"]+/, 'password=***')
      : arg,
  );
}

export function describeGitError(
  error: unknown,
  timeoutMs: number,
  args: string[],
): Error {
  const detail = error as { killed?: boolean; signal?: string | null } | null;
  if (detail?.killed) {
    return new Error(
      `git ${maskCredentialArgs(args).join(' ')} timed out after ${timeoutMs}ms` +
        (detail.signal ? ` (signal ${detail.signal})` : '') +
        ` — увеличить таймаут: GIT_TIMEOUT_MS`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function isNothingToCommitError(error: unknown): boolean {
  const message = messageOf(error);
  return /nothing (added )?to commit/i.test(message);
}

export interface GitContext {
  exec: GitExecFile;
  timeoutMs: number;
  git(args: string[], cwd?: string): Promise<string>;
}

export function createGitContext(
  exec: GitExecFile,
  timeoutMs: number,
): GitContext {
  return {
    exec,
    timeoutMs,
    async git(args: string[], cwd?: string): Promise<string> {
      try {
        const { stdout } = await exec('git', args, {
          cwd,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          timeout: timeoutMs,
        });
        return stdout;
      } catch (error) {
        throw describeGitError(error, timeoutMs, args);
      }
    },
  };
}