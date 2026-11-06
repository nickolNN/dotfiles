import { numberOrNull } from '@issue-resolver/shared';

import { stringOrNull } from './scalars';

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function requireRecord(
  value: unknown,
  what: string,
): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new Error(`${what}: expected a JSON object`);
  return record;
}

export function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected a JSON array`);
  return value;
}

export function requireString(
  record: Record<string, unknown>,
  key: string,
  what: string,
): string {
  const value = stringOrNull(record[key]);
  if (value === null) throw new Error(`${what}: ${key} is not a string`);
  return value;
}

export function requireNumber(
  record: Record<string, unknown>,
  key: string,
  what: string,
): number {
  const value = numberOrNull(record[key]);
  if (value === null) throw new Error(`${what}: ${key} is not a number`);
  return value;
}