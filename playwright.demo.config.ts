import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

// `npm run test:e2e:demo`: the same tests in a visible browser, slowed down and with on-screen captions
// (see say() in e2e/booking.spec.ts), so a screen recording explains itself.
export default defineConfig({
  ...base,
  reporter: 'list',
  timeout: 120_000,
  use: {
    ...base.use,
    headless: false,
    viewport: { width: 1400, height: 900 },
    launchOptions: { slowMo: 400 },
  },
  projects: [{ name: 'chromium-demo', metadata: { narrate: true } }],
});
