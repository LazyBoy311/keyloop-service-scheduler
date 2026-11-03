import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

// `npm run test:e2e:demo`: same tests in a visible browser, slowed down so they can be watched or recorded.
export default defineConfig({
  ...base,
  reporter: 'list',
  use: {
    ...base.use,
    headless: false,
    viewport: { width: 1400, height: 900 },
    launchOptions: { slowMo: 700 },
  },
  projects: [{ name: 'chromium-demo' }],
});
