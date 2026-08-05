import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
  },
  // Server managed by test:e2e npm script
});
