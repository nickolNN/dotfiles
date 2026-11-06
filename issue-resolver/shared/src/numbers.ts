export const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;