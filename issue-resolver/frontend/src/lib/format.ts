interface TokenScale {
  scaled: number;
  suffix: '' | 'k' | 'M';
}

interface TokenFormatOptions {
  keepZeroFraction?: boolean;
}

const UUID_SEGMENT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tokenScale(total: number): TokenScale {
  if (total >= 1_000_000) return { scaled: total / 1_000_000, suffix: 'M' };
  if (total >= 1000) return { scaled: total / 1000, suffix: 'k' };
  return { scaled: total, suffix: '' };
}

export function formatTokens(
  total: number | null | undefined,
  { keepZeroFraction = false }: TokenFormatOptions = {},
): string {
  if (total === null || total === undefined) return '—';
  if (!Number.isFinite(total) || total <= 0) return '0';
  const { scaled, suffix } = tokenScale(total);
  if (suffix === '') return String(Math.round(scaled));
  const fixed = scaled.toFixed(1);
  return `${keepZeroFraction ? fixed : fixed.replace(/\.0$/, '')}${suffix}`;
}

export function formatInstantSpeed(value: number): string {
  return value.toFixed(1);
}

export function formatAvgSpeed(value: number): string {
  return String(Math.round(value));
}

export function formatCost(total: number, estimate = false): string {
  const marker = estimate ? '≈' : '';
  if (!Number.isFinite(total) || total <= 0) return `${marker}$0`;
  return `${marker}$${total.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} Б`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} КБ`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} МБ`;
}

export function formatCompactionTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return '—';
  return formatTokens(value, { keepZeroFraction: true });
}

export function shortPath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const uuidIndex = segments.findIndex((segment) => UUID_SEGMENT_RE.test(segment));
  if (uuidIndex === -1) {
    if (!path.startsWith('/')) return path;
    return segments.slice(-2).join('/');
  }
  const remainder = segments.slice(uuidIndex + 1);
  if (remainder.length === 0) return segments[uuidIndex];
  if (remainder.length <= 2) return remainder.join('/');
  return remainder[remainder.length - 1];
}