import { expect, test } from '@playwright/test';
import {
  API,
  E2E_API_ORIGIN,
  createIssueViaUI,
  pollIssueStatus,
  uniqueTitle,
} from '../helpers';

const now = () => new Date().toISOString();

const REPORT_HTML = `<!DOCTYPE html><html><head><title>Отчёт</title></head><body><h1>Итог прогона</h1><p>E2E: отчёт сгенерирован</p></body></html>`;

function reportStatus(
  status: 'idle' | 'running' | 'success' | 'failed',
  present: boolean,
): Record<string, unknown> {
  return {
    status,
    artifacts: {
      md: { present, bytes: present ? 128 : 0, mtime: present ? now() : null },
      html: {
        present,
        bytes: present ? 256 : 0,
        mtime: present ? now() : null,
      },
    },
    updatedAt: now(),
    ...(present ? { lastRunAt: now(), feedback: 'Готовы HTML и markdown' } : {}),
  };
}

interface SseEnvelope {
  type?: string;
  stepRunId?: string;
}

async function collectStepStatuses(
  issueId: string,
  expectedRunId: string,
  timeoutMs: number,
): Promise<SseEnvelope[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events: SseEnvelope[] = [];
  const reached = () =>
    events.some(
      (event) =>
        event.type === 'step_status' && event.stepRunId === expectedRunId,
    );
  let buffer = '';
  try {
    const response = await fetch(
      `${E2E_API_ORIGIN}${API}/issues/${issueId}/stream`,
      { signal: controller.signal, headers: { Accept: 'text/event-stream' } },
    );
    const reader = response.body?.getReader();
    if (!reader) return events;
    const decoder = new TextDecoder();
    while (!reached()) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = block
          .split('\n')
          .find((candidate) => candidate.startsWith('data: '));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(6)) as SseEnvelope);
          } catch (error) {
            void error;
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    void error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

test.describe('report flow', () => {
  test('idle → запуск → success → артефакт → повторный запуск', async ({
    page,
  }) => {
    const title = uniqueTitle('e2e-report-cycle');
    let statusPayload: Record<string, unknown> = reportStatus('idle', false);
    let postCount = 0;

    await page.route('**/issues/*/report/status', (route) =>
      route.fulfill({ json: statusPayload }),
    );
    await page.route('**/issues/*/report', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      postCount += 1;
      statusPayload = reportStatus('success', true);
      return route.fulfill({ json: { ok: true, reportRunId: 'issue.report' } });
    });
    await page.route('**/issues/*/result', (route) => {
      if (route.request().method() === 'HEAD') {
        return route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '',
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: REPORT_HTML,
      });
    });

    await createIssueViaUI(page, { title, bootstrapEnabled: false });

    await expect(page.getByTestId('report-idle')).toBeVisible();

    await page.getByTestId('refresh-report').click();
    expect(postCount).toBe(1);
    await expect(page.getByTestId('report-ready')).toBeVisible();

    await page.getByTestId('open-result').click();
    await expect(page.getByTestId('result-modal')).toBeVisible();
    await expect(page.getByTestId('result-html')).toBeVisible();
    await page.getByTestId('result-modal-close').click();
    await expect(page.getByTestId('result-modal')).toBeHidden();

    await page.getByTestId('refresh-report').click();
    expect(postCount).toBe(2);
    await expect(page.getByTestId('report-ready')).toBeVisible();
  });

  test('отсутствующая задача: ошибка запуска показывается в панели отчёта', async ({
    page,
  }) => {
    const title = uniqueTitle('e2e-report-missing');
    const missing = { error: 'issue not found' };

    await page.route('**/issues/*/report/status', (route) =>
      route.fulfill({ status: 404, json: missing }),
    );
    await page.route('**/issues/*/report', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({ status: 404, json: missing });
    });

    await createIssueViaUI(page, { title, bootstrapEnabled: false });

    await page.getByTestId('refresh-report').click();

    const error = page.getByTestId('report-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('issue not found');
  });

  test('SSE доставляет step_status report-прогона', async ({ page, request }) => {
    const title = uniqueTitle('e2e-report-sse');
    const issueId = await createIssueViaUI(page, {
      title,
      bootstrapEnabled: false,
    });

    await pollIssueStatus(
      request,
      issueId,
      (status) => ['completed', 'failed', 'cancelled'].includes(status),
      60_000,
    );

    const expectedRunId = `issue.${issueId}.report`;
    const collecting = collectStepStatuses(issueId, expectedRunId, 25_000);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = await request.post(
      `${E2E_API_ORIGIN}${API}/issues/${issueId}/report`,
    );
    expect(started.status(), await started.text()).toBe(202);

    const events = await collecting;
    expect(
      events.some(
        (event) =>
          event.type === 'step_status' && event.stepRunId === expectedRunId,
      ),
      JSON.stringify(events.slice(0, 5)),
    ).toBe(true);
  });
});
