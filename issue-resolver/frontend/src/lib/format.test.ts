import { describe, expect, it } from 'vitest';
import {
  formatAvgSpeed,
  formatCompactionTokens,
  formatCost,
  formatFileSize,
  formatInstantSpeed,
  formatTokens,
} from './format';

describe('lib/format', () => {
  it('formatTokens масштабирует k/M, обрабатывает null/0 и убирает .0', () => {
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(1_000_000)).toBe('1M');
  });

  it('formatTokens с keepZeroFraction сохраняет один знак после точки', () => {
    expect(formatTokens(1000, { keepZeroFraction: true })).toBe('1.0k');
    expect(formatTokens(1_500_000, { keepZeroFraction: true })).toBe('1.5M');
  });

  it('formatInstantSpeed и formatAvgSpeed различаются округлением', () => {
    expect(formatInstantSpeed(63.5)).toBe('63.5');
    expect(formatInstantSpeed(42)).toBe('42.0');
    expect(formatAvgSpeed(42.4)).toBe('42');
    expect(formatAvgSpeed(42.6)).toBe('43');
  });

  it('formatCompactionTokens: null/0 → —, иначе token scale с .0', () => {
    expect(formatCompactionTokens(null)).toBe('—');
    expect(formatCompactionTokens(0)).toBe('—');
    expect(formatCompactionTokens(1500)).toBe('1.5k');
  });

  it('formatCost убирает хвостовые нули', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(0.0123)).toBe('$0.0123');
    expect(formatCost(0.01)).toBe('$0.01');
  });

  it('formatFileSize использует Б/КБ/МБ', () => {
    expect(formatFileSize(512)).toBe('512 Б');
    expect(formatFileSize(1536)).toBe('1.5 КБ');
    expect(formatFileSize(10 * 1024)).toBe('10 КБ');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 МБ');
  });
});
