import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const plugin = require(join(root, 'dist', 'main.cjs'));
const storage = mkdtempSync(join(tmpdir(), 'matcha-office-slides-test-'));
const tools = new Map();
let page;

const context = {
  pluginId: 'matcha.office',
  version: '0.1.0',
  storagePath: storage,
  packagePath: join(root, 'dist'),
  registerTool(name, handler) {
    tools.set(name, handler);
    return () => tools.delete(name);
  },
  async requestConfirmation() {
    return false;
  },
  publish(topic, data) {
    void page?.evaluate(({ topic, data }) => window.__officePublish?.(topic, data), { topic, data }).catch(() => {});
  },
  log: { info() {}, error() {} }
};

const signal = new AbortController().signal;
async function callTool(name, args) {
  const handler = tools.get(name);
  if (!handler) throw new Error(`tool ${name} is not registered`);
  return handler(args, { signal, reportProgress() {} });
}

const disposePlugin = await plugin.activate(context);
const created = await callTool('document_create', {
  type: 'pptx',
  name: 'Smoke.pptx',
  source: '[]',
  sourceFormat: 'ops'
});
const exported = await callTool('document_export', {
  documentId: created.structuredContent.document.id,
  format: 'original'
});
const opened = await callTool('office_slides_open', {
  documentId: created.structuredContent.document.id,
  name: 'Smoke.pptx',
  data: exported.structuredContent.data
});
assert.ok(opened.structuredContent.presentation?.slides?.length >= 1, 'slides session returned no pages');

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(new Error(message.text()));
});
await page.exposeFunction('__officeCall', (name, args) => callTool(name, args));
await page.addInitScript(() => {
  const listeners = new Set();
  window.__officeListeners = listeners;
  window.__officePublish = (topic, data) => {
    for (const listener of listeners) listener({ topic, data });
  };
  window.matchaApp = {
    pluginId: 'matcha.office',
    context: { language: 'en', theme: 'light' },
    call: (name, args) => window.__officeCall(name, args ?? {}),
    async compose() {},
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
});

try {
  await page.goto(pathToFileURL(join(root, 'dist', 'slides.html')).href, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => {
      const root = document.getElementById('root');
      return !!root && root.childElementCount > 0 && !!document.querySelector('.app-main');
    }, undefined, { timeout: 30_000 });
  } catch (error) {
    console.error('Slides page did not render. Errors:', errors.map((value) => value.message ?? String(value)));
    console.error('Root HTML:', (await page.evaluate(() => document.body.innerHTML)).slice(0, 1500));
    throw error;
  }
  const rendered = await page.evaluate(() => document.getElementById('root').childElementCount);
  assert.ok(rendered > 0, 'slides UI rendered nothing');
  const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length);
  assert.ok(canvases > 0, 'slides editor rendered no canvas');
  if (errors.length) throw errors[0];
  console.log('Matcha Office Slides browser smoke test passed.');
} finally {
  await browser.close();
  await disposePlugin();
  rmSync(storage, { recursive: true, force: true });
}
