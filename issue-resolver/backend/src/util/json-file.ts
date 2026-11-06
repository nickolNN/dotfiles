import { readTextFileOrNull } from './files';

export const JSON_PARSE_FAILED: unique symbol = Symbol('json-parse-failed');

export function tryParseJson(
  raw: string | null | undefined,
): unknown | typeof JSON_PARSE_FAILED {
  if (!raw) return JSON_PARSE_FAILED;
  try {
    return JSON.parse(raw);
  } catch {
    return JSON_PARSE_FAILED;
  }
}

export function readJsonFile<T>(
  path: string,
  parse: (value: unknown) => T | null,
): T | null {
  const value = tryParseJson(readTextFileOrNull(path));
  return value === JSON_PARSE_FAILED ? null : parse(value);
}