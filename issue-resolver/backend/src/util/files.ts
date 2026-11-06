import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

function nonBlank(text: string): string | null {
  return text.trim().length > 0 ? text : null;
}

export function readTextFileOrNull(path: string): string | null {
  try {
    return nonBlank(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function readTextFileOrNullAsync(
  path: string,
): Promise<string | null> {
  try {
    return nonBlank(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}