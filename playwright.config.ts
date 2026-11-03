import { defineConfig, devices } from '@playwright/test';

// End-to-end tests of the demo UI against the real server and a fresh in-memory database.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false, // one shared server; each test uses its own day so they never see each other's bookings
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3100',
    // `npm run test:e2e:demo` opens a visible browser and slows each action down so it can be watched or recorded.
    launchOptions: { slowMo: process.argv.includes('--headed') ? 600 : 0 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning src/server.ts',
    url: 'http://localhost:3100/health',
    env: { PORT: '3100', DB_PATH: ':memory:', LOG_LEVEL: 'warn' },
    reuseExistingServer: false,
  },
});
