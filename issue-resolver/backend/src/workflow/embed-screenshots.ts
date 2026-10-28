import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'bin',
  'embed-screenshots.mjs',
);

export interface EmbedScreenshotsResult {
  summary: string;
  ok: boolean;
}

export interface EmbedScreenshotsOptions {
  keepOriginal?: boolean;
  lossless?: boolean;
  timeoutMs?: number;
}

export async function embedReportScreenshots(
  hostDir: string,
  options: EmbedScreenshotsOptions = {},
): Promise<EmbedScreenshotsResult> {
  const args = [SCRIPT, 'report.html', '--quiet'];
  if (options.keepOriginal) args.push('--keep-png');
  if (options.lossless) args.push('--lossless');

  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: hostDir,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 1024 * 1024,
    });
    return { summary: lastLine(stdout) ?? 'nothing to inline', ok: true };
  } catch (error) {
    const failure = error as {
      message?: string;
      stdout?: string;
      stderr?: string;
    };
    const summary = [lastLine(failure.stdout), lastLine(failure.stderr)]
      .filter(Boolean)
      .join('; ');
    return {
      summary: summary || failure.message || 'embed-screenshots failed',
      ok: false,
    };
  }
}

function lastLine(output: string | undefined): string | null {
  const line = (output ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .pop();
  return line ?? null;
}