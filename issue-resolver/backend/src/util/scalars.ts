export const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

export const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

export const boolOrNull = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

export const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];