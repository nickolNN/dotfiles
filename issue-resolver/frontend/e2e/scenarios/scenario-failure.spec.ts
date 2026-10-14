import { expect, test } from '@playwright/test';
import {
  createIssueViaUI,
  pollIssueStatus,
  resetScenario,
  setScenario,
  uniqueTitle,
  waitForStatus,
} from '../helpers';

/**
 * Сценарный прогон «шаг падает»: refine проходит, resolve падает (`step #2`),
 * итерация и задача → `failed`. Мок-агент, без Docker/pi/сети.
 */
test.describe('scenario: step failure', () => {
  test.afterEach(async ({ request }) => {
    await resetScenario(request);
  });

  test('падает второй шаг → задача failed', async ({ page, request }) => {
    await setScenario(request, { scenario: 'step-failure' });
    const title = uniqueTitle('e2e-scenario-failure');

    // refine включаем, чтобы прогон состоял из двух шагов и падал именно #2.
    const issueId = await createIssueViaUI(page, { title, refine: true });

    const final = await pollIssueStatus(request, issueId, (status) =>
      ['failed', 'completed'].includes(status),
    );
    expect(final).toBe('failed');

    await page.reload();
    await waitForStatus(page, 'failed');
  });
});