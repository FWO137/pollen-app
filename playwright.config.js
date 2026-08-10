// @ts-check
import { defineConfig } from '@playwright/test';

// End-to-end regression tests for behavior that pollen-logic.js's
// dependency-free unit tests (tests/pollen-logic.test.mjs, run via
// `npm test`) can't exercise — real DOM/fetch/timing integration.
// Requires Playwright browsers: `npx playwright install chromium`.
// Run with `npm run test:e2e`.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 15000,
  fullyParallel: true,
  use: {
    baseURL: 'http://localhost:8934',
  },
  webServer: {
    command: 'node tests/e2e/serve.mjs',
    port: 8934,
    reuseExistingServer: !process.env.CI,
  },
});
