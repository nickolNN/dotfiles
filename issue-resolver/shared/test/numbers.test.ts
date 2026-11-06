import { describe, expect, it } from 'vitest';

import { num, numberOrNull } from '../src/numbers';

describe('num', () => {
  it('keeps finite numbers unchanged', () => {
    expect(num(0)).toBe(0);
    expect(num(-3.5)).toBe(-3.5);
    expect(num(42)).toBe(42);
  });

  it('turns NaN and infinities into 0', () => {
    expect(num(Number.NaN)).toBe(0);
    expect(num(Number.POSITIVE_INFINITY)).toBe(0);
    expect(num(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('turns non-numbers into 0', () => {
    expect(num('12')).toBe(0);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num({})).toBe(0);
  });
});

describe('numberOrNull', () => {
  it('keeps finite numbers unchanged', () => {
    expect(numberOrNull(0)).toBe(0);
    expect(numberOrNull(-2)).toBe(-2);
  });

  it('returns null for NaN and infinities', () => {
    expect(numberOrNull(Number.NaN)).toBeNull();
    expect(numberOrNull(Number.POSITIVE_INFINITY)).toBeNull();
    expect(numberOrNull(Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('returns null for non-numbers', () => {
    expect(numberOrNull('12')).toBeNull();
    expect(numberOrNull(null)).toBeNull();
    expect(numberOrNull(undefined)).toBeNull();
  });
});