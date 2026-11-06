import { JSON_PARSE_FAILED, tryParseJson } from '../util/json-file';

export const nowIso = (): string =>
  new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export function parseJsonColumn<T>(
  raw: string | null,
  parse: (value: unknown) => T | null,
): T | null {
  const value = tryParseJson(raw);
  return value === JSON_PARSE_FAILED ? null : parse(value);
}