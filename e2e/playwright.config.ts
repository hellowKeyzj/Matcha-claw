import { defineConfig } from '@playwright/test';
import type { SerenityFixtures, SerenityWorkerFixtures } from '@serenity-js/playwright-test';
import { profileMode } from './src/config/electron.js';

export default defineConfig<SerenityFixtures, SerenityWorkerFixtures>({
  testDir: './src/scenarios',
  testMatch: '**/*.spec.ts',
  testIgnore: profileMode === 'licensed'
    ? '**/unlicensed-license.spec.ts'
    : ['**/licensed-license.spec.ts', '**/licensed/**'],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  maxFailures: 1,
  forbidOnly: true,
  outputDir: './test-results',
  reporter: [
    ['list'],
    ['json', { outputFile: './test-results/results.json' }],
    ['html', { outputFolder: './playwright-report', open: 'never' }],
    ['@serenity-js/playwright-test', {
      crew: [['@serenity-js/html-reporter', {
        outputDirectory: './serenity-report',
        specDirectory: './src/scenarios',
        title: 'MatchaClaw Electron E2E',
      }]],
    }],
  ],
});
