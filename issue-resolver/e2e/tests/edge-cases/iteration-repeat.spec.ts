import { expect, test } from '@playwright/test';
import { FakeApi, pollIterationStatus } from '../../helpers';

test.describe('edge: повтор итерации', () => {
  test('#2 стартует, результат #1 остаётся доступным', async ({ page }) => {
    const api = new FakeApi();
    await api.install(page);

    const { issue, iteration } = api.addIssue({
      title: 'Повтор',
      status: 'completed',
    });
    api.addStepRun(iteration.id, {
      step: 'resolve',
      status: 'success',
      report: JSON.stringify({ status: 'pass', summary: 'готово' }),
    });
    api.resultMd.set(issue.id, '# Итог первой итерации');

    await page.goto(`/#/tasks/${issue.id}`);
    await expect(page.getByText('Итерация #1')).toBeVisible();
    await expect(page.getByTestId('repeat-iteration')).toBeEnabled();

    await page.getByTestId('repeat-iteration').click();
    await expect(page.getByText('Итерация #2')).toBeVisible({
      timeout: 15_000,
    });
    await pollIterationStatus(page, 'running');

    const openResult = page.getByTestId('open-result');
    await expect(openResult).toBeEnabled();
    await openResult.click();
    await expect(page.getByTestId('result-modal')).toBeVisible();
    await expect(page.getByTestId('result-markdown')).toContainText(
      'Итог первой итерации',
    );
  });
});