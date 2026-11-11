import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = pathToFileURL(join(root, 'dist', 'docs.html')).href;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(new Error(message.text()));
});
await page.addInitScript(() => {
  window.matchaApp = {
    pluginId: 'matcha.office',
    context: { language: 'en', theme: 'light' },
    async call() {
      throw new Error('The browser smoke test does not serve tool calls.');
    },
    async compose() {},
    subscribe() {
      return () => {};
    }
  };
});
await page.goto(html, { waitUntil: 'load' });
await page.waitForSelector('.app-main', { timeout: 30_000 });
const shell = await page.locator('.app-main').count();
assert.equal(shell, 1);
if (errors.length) throw errors[0];
await browser.close();
console.log('Matcha Office Docs browser smoke test passed.');
