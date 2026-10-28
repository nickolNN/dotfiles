import { expect, test } from '@playwright/test';
import {
  createIssueViaUI,
  pollIssueStatus,
  resetScenario,
  setScenario,
  uniqueTitle,
  waitForStatus,
} from '../helpers';

test.describe('scenario: bootstrap failure', () => {
  test.afterEach(async ({ request }) => {
    await resetScenario(request);
  });

  test('подготовка падает → задача failed', async ({ page, request }) => {
    await setScenario(request, { scenario: 'bootstrap-failure' });
    const title = uniqueTitle('e2e-scenario-bootstrap-fail');

    const issueId = await createIssueViaUI(page, { title });

    const final = await pollIssueStatus(request, issueId, (status) =>
      ['failed', 'completed'].includes(status),
    );
    expect(final).toBe('failed');

    await page.reload();
    await waitForStatus(page, 'failed');
  });
});