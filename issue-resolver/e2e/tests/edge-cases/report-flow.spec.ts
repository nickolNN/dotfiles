import { expect, test } from '@playwright/test';
import { FakeApi } from '../../helpers';

const API = '/issue-resolver/api/v1';
const BASE_URL = 'http://localhost:5196';

/**
 * Имя модели/провайдера не должно встречаться НИ в одном артефакте отчёта
 * (жёсткое правило юзера). Паттерны — точные и экранированные, чтобы не ловить
 * ложняк вроде неэкранированной точки (`parent.` → «parents»).
 */
const MODEL_LEAK_PATTERNS: RegExp[] = [
  /\bprovider\d+\/[a-z0-9._-]+/i,
  /model:\s*`?[a-z0-9._-]+\/[a-z0-9._-]+/i,
  /Модель:/i,
  /\*\*Model:\*\*/i,
  /\b(?:deepseek|claude-|gpt-|qwen|sonnet|haiku)/i,
];

/**
 * Полный flow report-агента через FakeApi (API-уровень, без UI).
 *
 * Все запросы — через `page.evaluate(() => fetch(...))`, так как
 * `page.route()` перехватывает ТОЛЬКО запросы страницы (fetch/XHR),
 * но не `page.request` (отдельный APIRequestContext).
 *
 * about:blank + <base href> дают валидный origin для resolve URL.
 */
test.describe('edge: report flow (API)', () => {
  /** Ставит <base href> на about:blank, чтобы fetch/EventSource резолвили URL. */
  async function setupPage(page: any): Promise<void> {
    await page.goto('about:blank');
    await page.evaluate((base: string) => {
      const el = document.createElement('base');
      el.href = base;
      document.head.appendChild(el);
    }, BASE_URL);
  }

  /** GET-запрос изнутри страницы (проходит через page.route → FakeApi). */
  async function apiGet(
    page: any,
    path: string,
  ): Promise<{ status: number; body: string }> {
    return page.evaluate((url: string) =>
      fetch(url).then(async (r: Response) => ({
        status: r.status,
        body: await r.text(),
      })),
    path);
  }

  /** POST-запрос изнутри страницы. */
  async function apiPost(
    page: any,
    path: string,
  ): Promise<{ status: number; body: string }> {
    return page.evaluate((url: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).then(async (r: Response) => ({
        status: r.status,
        body: await r.text(),
      })),
    path);
  }

  // ── тесты ──

  test('полный цикл: idle → POST → success → артефакты + повтор', async ({
    page,
  }) => {
    const api = new FakeApi();
    await api.install(page);
    await setupPage(page);

    const { issue } = api.addIssue({
      title: 'Отчёт — полный цикл',
      status: 'completed',
      pipeline_steps: ['refine', 'resolve', 'review', 'pr'],
    });
    api.addIteration(issue.id, { number: 2, status: 'completed' });

    // До генерации: статус idle
    const idle = await apiGet(
      page,
      `${API}/issues/${issue.id}/report/status`,
    );
    expect(idle.status).toBe(200);
    expect(JSON.parse(idle.body)).toMatchObject({ status: 'idle' });

    // Результата ещё нет
    const noResult = await apiGet(page, `${API}/issues/${issue.id}/result`);
    expect(noResult.status).toBe(404);

    // POST /report → 202
    const post = await apiPost(page, `${API}/issues/${issue.id}/report`);
    expect(post.status).toBe(202);
    expect(JSON.parse(post.body)).toMatchObject({
      ok: true,
      reportRunId: `${issue.id}/report`,
    });

    // GET /report/status → success
    const status = await apiGet(
      page,
      `${API}/issues/${issue.id}/report/status`,
    );
    expect(status.status).toBe(200);
    const sb = JSON.parse(status.body);
    expect(sb.status).toBe('success');
    expect(typeof sb.lastRunAt).toBe('string');

    // report.html — самодостаточный HTML
    const html = await apiGet(page, `${API}/issues/${issue.id}/result`);
    expect(html.status).toBe(200);
    const hb = html.body;
    expect(hb).toContain('<!DOCTYPE html>');
    expect(hb).toContain('<style>');
    expect(hb).toContain(issue.title);

    // Внешние ССЫЛКИ разрешены (MR виден в Answer), но ЗАГРУЗКА ресурса
    // извне — нет: файл открывается с file:// в sandbox без сети.
    for (const forbidden of [
      /<script[^>]+\bsrc=/i,
      /<link[^>]+href=["']https?:/i,
      /url\(["']?https?:/i,
      /<img[^>]+\bsrc=["']https?:/i,
      /<iframe[\s>]/i,
      /\bfetch\s*\(/,
      /\bnew\s+WebSocket\b/,
      /\bnew\s+EventSource\b/,
    ]) {
      expect(hb, `запрещённая сетевая примитива: ${forbidden}`).not.toMatch(
        forbidden,
      );
    }
    // Инлайн vanilla-JS как progressive enhancement — легален и присутствует.
    expect(hb).toContain('<script>');
    expect(hb).not.toContain('<link');
    // MR-ссылка обязана быть в Answer, а не только в свёрнутом блоке.
    expect(hb).toMatch(/<a[^>]+href="https?:[^"]+"[^>]*target="_blank"/);

    // Имя модели/провайдера не должно утечь в HTML-отчёт.
    for (const pattern of MODEL_LEAK_PATTERNS) {
      expect(hb, `id модели утёк в report.html: ${pattern}`).not.toMatch(
        pattern,
      );
    }

    // Скелет: единственный <details> без `open`, прижатый к концу страницы;
    // открытый Answer идёт до него.
    const detailsTags = hb.match(/<details[\s>]/gi) ?? [];
    expect(detailsTags).toHaveLength(1);
    expect(hb).not.toMatch(/<details[^>]*\sopen[\s=>]/i);
    const answerAt = hb.search(/<h[12][^>]*>\s*Answer\b/i);
    const detailsAt = hb.search(/<details[\s>]/i);
    expect(answerAt).toBeGreaterThan(-1);
    expect(detailsAt).toBeGreaterThan(answerAt);
    // Старый каркас не должен вернуться.
    expect(hb).not.toContain('Executive Summary');

    // report.md — доступен когда нет HTML
    api.resultHtml.delete(issue.id);
    const md = await apiGet(page, `${API}/issues/${issue.id}/result`);
    expect(md.status).toBe(200);
    const mb = md.body;
    expect(mb).toMatch(/# Task:/);
    expect(mb).toMatch(/\*\*Status:\*\*/);

    // Каркас MD: `## Answer` первым, `## Execution details` последним.
    const mdAnswer = mb.search(/^## Answer$/m);
    const mdExecution = mb.search(/^## Execution details$/m);
    expect(mdAnswer).toBeGreaterThan(-1);
    expect(mdExecution).toBeGreaterThan(mdAnswer);
    expect(mb).not.toMatch(/^## Executive Summary$/m);
    expect(mb).not.toMatch(/^## Iteration \d/m);
    // MR-ссылка — в Answer, до Execution details.
    expect(mb.slice(0, mdExecution)).toMatch(/https?:\/\//);

    // Имя модели/провайдера не должно утечь в markdown-отчёт.
    for (const pattern of MODEL_LEAK_PATTERNS) {
      expect(mb, `id модели утёк в report.md: ${pattern}`).not.toMatch(pattern);
    }

    // Повторный POST перезаписывает
    const post2 = await apiPost(page, `${API}/issues/${issue.id}/report`);
    expect(post2.status).toBe(202);
    const s2 = await apiGet(
      page,
      `${API}/issues/${issue.id}/report/status`,
    );
    expect(JSON.parse(s2.body).status).toBe('success');
  });

  test('несуществующая задача → 404', async ({ page }) => {
    const api = new FakeApi();
    await api.install(page);
    await setupPage(page);

    const post = await apiPost(page, `${API}/issues/nonexistent/report`);
    expect(post.status).toBe(404);

    const status = await apiGet(
      page,
      `${API}/issues/nonexistent/report/status`,
    );
    expect(status.status).toBe(404);
  });

  test('SSE: step_status для report попадает в очередь и доставляется', async ({
    page,
  }) => {
    const api = new FakeApi();
    await api.install(page);
    await setupPage(page);

    const { issue } = api.addIssue({
      title: 'SSE-видимость',
      status: 'completed',
    });
    const reportRunId = `${issue.id}/report`;

    // Триггерим генерацию СНАЧАЛА (pushSse кладёт событие в очередь)
    await apiPost(page, `${API}/issues/${issue.id}/report`);

    // Подключаем EventSource ПОСЛЕ — он получает всё из очереди
    const events = await page.evaluate(
      ({
        apiPath,
        expectedRunId,
      }: {
        apiPath: string;
        expectedRunId: string;
      }) =>
        new Promise<Array<{ type: string; stepRunId?: string }>>(
          (resolve) => {
            const collected: Array<{
              type: string;
              stepRunId?: string;
            }> = [];
            const es = new EventSource(apiPath);
            es.onmessage = (msg: MessageEvent) => {
              try {
                const parsed = JSON.parse(msg.data);
                collected.push(parsed);
                if (
                  parsed.type === 'step_status' &&
                  parsed.stepRunId === expectedRunId
                ) {
                  es.close();
                  resolve(collected);
                }
              } catch {
                /* skip */
              }
            };
            es.onerror = () => {
              es.close();
              resolve(collected);
            };
            setTimeout(() => {
              es.close();
              resolve(collected);
            }, 3000);
          },
        ),
      {
        apiPath: `${API}/issues/${issue.id}/stream`,
        expectedRunId: reportRunId,
      },
    );

    const found = events.find(
      (e) => e.type === 'step_status' && e.stepRunId === reportRunId,
    );
    expect(found).toBeTruthy();
  });
});