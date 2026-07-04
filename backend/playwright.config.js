const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3108',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    command: 'node src/server.js',
    url: 'http://127.0.0.1:3108/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
    env: {
      DATABASE_URL: 'postgresql://amq:amq@127.0.0.1:5432/amq_e2e',
      JWT_SECRET: 'e2e-only-secret-that-is-long-enough-for-validation',
      NODE_ENV: 'test',
      PORT: '3108',
      SKIP_BACKGROUND_REFRESH: 'true',
    },
  },
});
