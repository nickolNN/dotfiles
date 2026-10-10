import { defineConfig } from '@playwright/test';

/**
 * Playwright-конфиг для e2e Issue Resolver.
 *
 * Серверы уже подняты стиком (backend :8080, vite :5173), поэтому
 * `reuseExistingServer: true`: если http://localhost:5173 отвечает,
 * webServer не запускается. Если нет — поднимаем оба процесса из корня.
 */
export default defineConfig({
  testDir: './tests',
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
  },
  webServer: {
    command:
      'sh -c "npm run start --workspace @issue-resolver/backend & npm run dev --workspace @issue-resolver/frontend -- --host 0.0.0.0 --port 5173"',
    cwd: '..',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});