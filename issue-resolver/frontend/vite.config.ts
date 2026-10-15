import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Цель dev-прокси `/issue-resolver`. Продовый дефолт — реальный backend :8080;
 * Playwright e2e подменяет её на мок-бэкенд (`VITE_PROXY_TARGET`), чтобы
 * прогон шёл без Docker/pi/сети.
 */
const proxyTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/issue-resolver': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    // e2e/ — Playwright-спеки (другой раннер), vitest их не собирает.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});