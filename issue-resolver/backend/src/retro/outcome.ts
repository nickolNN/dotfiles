import { readTextFileOrNull } from '../util/files';
export { messageOf } from '../util/errors';

export function readReport(path: string): string | null {
  return readTextFileOrNull(path)?.trim() ?? null;
}

function failureText(exitCode: number, stderr: string): string {
  const tail = stderr.trim().split('\n').slice(-3).join(' ').trim();
  const code = `агент завершился с кодом ${exitCode}`;
  if (!tail) return code;
  return `${code}: ${tail}`;
}

export function reportErrorText(
  exitCode: number,
  stderr: string,
  hasReport: boolean,
  aborted = false,
): string | null {
  if (aborted) return 'прогон остановлен оператором';
  if (exitCode !== 0) return failureText(exitCode, stderr);
  if (!hasReport) return 'агент завершился без отчёта: файл отчёта не создан';
  return null;
}
