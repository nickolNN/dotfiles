export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isNullableString(value: unknown): boolean {
  return value === null || isString(value);
}

export function isNullableNumber(value: unknown): boolean {
  return value === null || isNumber(value);
}

export function isNullableBoolean(value: unknown): boolean {
  return value === null || isBoolean(value);
}

export function isOptionalOf(
  value: unknown,
  check: (item: unknown) => boolean,
): boolean {
  return value === undefined || check(value);
}

export function isArrayWhere(
  value: unknown,
  check: (item: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.every(check);
}

export function isOneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
): value is T {
  return isString(value) && allowed.some((item) => item === value);
}