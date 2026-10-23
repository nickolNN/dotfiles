import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { allowedOriginsFromEnv, isAllowedOrigin } from '../src/http/origin';

const ACAO = 'access-control-allow-origin';
const ISSUES_PATH = '/issue-resolver/api/v1/issues';

// =========================================================================
// Unit: isAllowedOrigin
// =========================================================================

describe('isAllowedOrigin', () => {
  const previous = process.env.ISSUE_RESOLVER_ALLOWED_ORIGINS;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.ISSUE_RESOLVER_ALLOWED_ORIGINS;
    } else {
      process.env.ISSUE_RESOLVER_ALLOWED_ORIGINS = previous;
    }
  });

  it('пустой origin (non-browser: curl, e2e, same-origin без заголовка) разрешён', () => {
    expect(isAllowedOrigin('')).toBe(true);
  });

  it('localhost/loopback http(s) в любом порту разрешены', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:8080')).toBe(true);
    expect(isAllowedOrigin('https://localhost')).toBe(true);
    expect(isAllowedOrigin('http://[::1]:8080')).toBe(true);
  });

  it('чужие домены, null и не-http схемы запрещены', () => {
    expect(isAllowedOrigin('http://evil.com')).toBe(false);
    expect(isAllowedOrigin('https://attacker.test')).toBe(false);
    // file:// и sandboxed iframe без allow-same-origin: Origin === 'null'.
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedOrigin('file://')).toBe(false);
    expect(isAllowedOrigin('chrome-extension://abcdef')).toBe(false);
  });

  it('env-список ISSUE_RESOLVER_ALLOWED_ORIGINS добавляет точный origin', () => {
    process.env.ISSUE_RESOLVER_ALLOWED_ORIGINS =
      'https://foo.example.com, https://bar.example.com ';

    expect(isAllowedOrigin('https://foo.example.com')).toBe(true);
    expect(isAllowedOrigin('https://bar.example.com')).toBe(true);
    expect(isAllowedOrigin('https://baz.example.com')).toBe(false);
  });

  it('wildcard `*` в env игнорируется (не открывает API)', () => {
    process.env.ISSUE_RESOLVER_ALLOWED_ORIGINS = '*';

    expect(allowedOriginsFromEnv()).toEqual([]);
    expect(isAllowedOrigin('http://evil.com')).toBe(false);
  });

  describe('локальный режим (ISSUE_RESOLVER_LOCAL=1)', () => {
    const previousLocal = process.env.ISSUE_RESOLVER_LOCAL;

    afterEach(() => {
      if (previousLocal === undefined) {
        delete process.env.ISSUE_RESOLVER_LOCAL;
      } else {
        process.env.ISSUE_RESOLVER_LOCAL = previousLocal;
      }
    });

    it('любой не-null origin разрешён (dev-контейнер, любой хост-IP)', () => {
      process.env.ISSUE_RESOLVER_LOCAL = '1';

      expect(isAllowedOrigin('http://192.168.50.219:5173')).toBe(true);
      expect(isAllowedOrigin('http://10.0.0.1:8080')).toBe(true);
      expect(isAllowedOrigin('http://evil.com')).toBe(true);
      expect(isAllowedOrigin('https://attacker.test')).toBe(true);
    });

    it('null по-прежнему запрещён', () => {
      process.env.ISSUE_RESOLVER_LOCAL = '1';

      expect(isAllowedOrigin('null')).toBe(false);
    });

    it('пустой origin по-прежнему разрешён', () => {
      process.env.ISSUE_RESOLVER_LOCAL = '1';

      expect(isAllowedOrigin('')).toBe(true);
    });
  });
});

// =========================================================================
// HTTP: часть A — чтение (access-control-allow-origin)
// =========================================================================

describe('CORS: часть A — allow-list чтения', () => {
  const app = buildApp(createDb(':memory:'));

  afterAll(async () => {
    await app.close();
  });

  it('GET с локальным Origin → access-control-allow-origin есть', async () => {
    const response = await app.inject({
      method: 'GET',
      url: ISSUES_PATH,
      headers: { origin: 'http://localhost:5173' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers[ACAO]).toBe('http://localhost:5173');
  });

  it('GET с чужим Origin → заголовка нет', async () => {
    const response = await app.inject({
      method: 'GET',
      url: ISSUES_PATH,
      headers: { origin: 'http://evil.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers[ACAO]).toBeUndefined();
  });

  it('GET с Origin: null → заголовка нет', async () => {
    const response = await app.inject({
      method: 'GET',
      url: ISSUES_PATH,
      headers: { origin: 'null' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers[ACAO]).toBeUndefined();
  });

  it('preflight: локальный origin разрешён, чужой — нет', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: ISSUES_PATH,
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
      },
    });
    expect(allowed.headers[ACAO]).toBe('http://localhost:5173');

    const blocked = await app.inject({
      method: 'OPTIONS',
      url: ISSUES_PATH,
      headers: {
        origin: 'http://evil.com',
        'access-control-request-method': 'POST',
      },
    });
    expect(blocked.headers[ACAO]).toBeUndefined();
  });
});

// =========================================================================
// HTTP: часть B — mutating-роуты (403 до обработчика)
// =========================================================================

describe('CORS: часть B — Origin на мутирующих методах', () => {
  const DRAFT = {
    title: 'origin-test',
    repositories: [],
    run_immediately: false,
  };

  async function withApp(
    run: (app: ReturnType<typeof buildApp>) => Promise<void>,
  ): Promise<void> {
    const app = buildApp(createDb(':memory:'));
    try {
      await run(app);
    } finally {
      await app.close();
    }
  }

  it('POST с чужим Origin → 403 { error }', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: ISSUES_PATH,
        headers: { origin: 'http://evil.com' },
        payload: DRAFT,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'origin not allowed' });
    });
  });

  it('POST с Origin: null → 403', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: ISSUES_PATH,
        headers: { origin: 'null' },
        payload: DRAFT,
      });

      expect(response.statusCode).toBe(403);
    });
  });

  it('POST без Origin → как раньше (201, черновик)', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: ISSUES_PATH,
        payload: DRAFT,
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().status).toBe('draft');
    });
  });

  it('POST с локальным Origin → как раньше (201)', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: ISSUES_PATH,
        headers: { origin: 'http://localhost:5173' },
        payload: DRAFT,
      });

      expect(response.statusCode).toBe(201);
    });
  });

  it('GET (не mutating) не задет частью B', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'GET',
        url: ISSUES_PATH,
        headers: { origin: 'http://evil.com' },
      });

      expect(response.statusCode).toBe(200);
    });
  });
});