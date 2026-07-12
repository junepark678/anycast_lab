import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: { baseURL: 'http://127.0.0.1:4173/lab/', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: './node_modules/.bin/tsc -b --pretty false && ./node_modules/.bin/vite build && ./node_modules/.bin/vite preview --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/lab/',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
