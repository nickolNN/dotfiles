import { expect, test } from '@playwright/test';
import {
  createIssueViaUI,
  pollIssueStatus,
  resetScenario,
  setScenario,
  uniqueTitle,
  waitForStatus,
} from '../helpers';

test.describe('scenario: agent question', () => {
  test.afterEach(async ({ request }) => {
    await resetScenario(request);
  });

  test('модалка → ответ → завершение', async ({ page, request }) => {
    await setScenario(request, { scenario: 'agent-question' });
    const title = uniqueTitle('e2e-scenario-question');

    const issueId = await createIssueViaUI(page, { title });
    const modal = page.getByTestId('question-modal');

    await expect(modal).toBeVisible({ timeout: 25_000 });
    await expect(modal).toContainText('уточните ожидаемое поведение');

    await modal.getByRole('radio', { name: 'продолжить' }).check();
    await modal.getByRole('button', { name: 'Ответить' }).click();
    await expect(modal).toBeHidden();

    const final = await pollIssueStatus(request, issueId, (status) =>
      ['completed', 'failed'].includes(status),
    );
    expect(final).toBe('completed');

    await page.reload();
    await waitForStatus(page, 'completed');
  });
});