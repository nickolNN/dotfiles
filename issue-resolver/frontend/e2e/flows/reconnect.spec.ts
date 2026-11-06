import { expect, test } from '@playwright/test';
import {
  createIssueViaUI,
  mockStreamBatches,
  uniqueTitle,
  workspaceProgress,
} from '../helpers';

const NETWORK_NOISE =
  /ERR_|net::|Failed to load resource|event-stream|stream/i;

test.describe('reconnect', () => {
  test('обрыв потока восстанавливается и поздние события приходят', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && !NETWORK_NOISE.test(message.text())) {
        consoleErrors.push(message.text());
      }
    });

    const title = uniqueTitle('e2e-reconnect');
    const before = [
      workspaceProgress('creating_dirs', 'running'),
      workspaceProgress('cloning', 'running', 'acme/one'),
    ];
    const after = [
      ...before,
      workspaceProgress('installing', 'running', 'acme/one'),
    ];

    await mockStreamBatches(page, '**/issues/*/stream', (call) =>
      call === 1 ? before : after,
    );

    await createIssueViaUI(page, { title, bootstrapEnabled: false });

    await expect(page.getByText('Клонирование acme/one')).toBeVisible();

    const reconnectChunk = page.getByText('Установка зависимостей acme/one');
    await expect(reconnectChunk).toBeVisible({ timeout: 30_000 });
    await expect(reconnectChunk).toHaveCount(1);

    expect(consoleErrors).toEqual([]);
  });
});