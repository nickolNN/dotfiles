
export const LOCAL_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function allowedOriginsFromEnv(raw?: string): string[] {
  return (raw ?? process.env.ISSUE_RESOLVER_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '' && value !== '*');
}

export function isAllowedOrigin(
  origin: string,
  extra: readonly string[] = allowedOriginsFromEnv(),
): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  if (process.env.ISSUE_RESOLVER_LOCAL === '1') return true;
  return LOCAL_ORIGIN.test(origin) || extra.includes(origin);
}