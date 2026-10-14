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
 * Сценарный прогон «агент задаёт вопрос» целиком на мок-агенте
 * (`POST /e2e/scenarios` → `agent-question`): без Docker/pi/сети.
 *
 * Реальный SSE-поток e2e-сервера приносит `question`-событие, UI открывает
 * модалку, ответ уходит в `POST /iterations/:id/ui-response` и раннер
 * продолжает шаг. Проверяем и «продолжение»: задача доходит до `completed`.
 */
test.describe('scenario: agent question', () => {
  test.afterEach(async ({ request }) => {
    await resetScenario(request);
  });

  test('модалка → ответ → завершение', async ({ page, request }) => {
    await setScenario(request, { scenario: 'agent-question' });
    const title = uniqueTitle('e2e-scenario-question');

    const issueId = await createIssueViaUI(page, { title });
    const modal = page.getByTestId('question-modal');

    // Вопрос приходит живым SSE-событием (задержка сценария даёт браузеру
    // время подписаться).
    await expect(modal).toBeVisible({ timeout: 25_000 });
    await expect(modal).toContainText('уточните ожидаемое поведение');

    // Отвечаем выбранным вариантом.
    await modal.getByRole('radio', { name: 'продолжить' }).check();
    await modal.getByRole('button', { name: 'Ответить' }).click();
    await expect(modal).toBeHidden();

    // Агент продолжил: задача терминально завершена.
    const final = await pollIssueStatus(request, issueId, (status) =>
      ['completed', 'failed'].includes(status),
    );
    expect(final).toBe('completed');

    // UI после перезагрузки показывает тот же терминальный статус.
    await page.reload();
    await waitForStatus(page, 'completed');
  });
});