/**
 * CORS-политика origin'ов — одна точка правды для чтения (CORS) и для
 * mutating-роутов (preHandler-хук в `app.ts`).
 *
 * Разрешены:
 *  - http(s) на localhost/loopback в любом порту (dev-фронт, прямая отладка);
 *  - точные origins из env `ISSUE_RESOLVER_ALLOWED_ORIGINS` (через запятую).
 *
 * Запрещены: `null` (file://, sandboxed iframe без allow-same-origin) и любые
 * чужие домены. Пустой origin (non-browser клиент: curl, e2e-скрипты, а также
 * same-origin запрос без заголовка) разрешён.
 */

export const LOCAL_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Origin'ы из env `ISSUE_RESOLVER_ALLOWED_ORIGINS`. Пустые элементы и `*`
 * отбрасываются: wildcard в этот allow-list не пробрасываем (защита от
 * случайного открытия локального API). `raw` — для тестов и явного вызова.
 */
export function allowedOriginsFromEnv(raw?: string): string[] {
  return (raw ?? process.env.ISSUE_RESOLVER_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '' && value !== '*');
}

/**
 * Пропускает ли политика этот `Origin`. Пустая строка (заголовка нет) —
 * разрешена; `null` — запрещён; localhost-паттерн или точная строка из env —
 * разрешены. Env читается на каждом вызове (важно для тестов и рантайма).
 */
export function isAllowedOrigin(
  origin: string,
  extra: readonly string[] = allowedOriginsFromEnv(),
): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  return LOCAL_ORIGIN.test(origin) || extra.includes(origin);
}