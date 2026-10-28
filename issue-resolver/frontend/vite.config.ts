import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});