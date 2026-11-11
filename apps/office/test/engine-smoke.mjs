import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const plugin = require(join(root, 'dist', 'main.cjs'));
const storage = mkdtempSync(join(tmpdir(), 'matcha-office-test-'));
const tools = new Map();
const events = [];

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
    events.push({ topic, data });
  },
  log: { info() {}, error() {} }
};

const signal = new AbortController().signal;
let disposePlugin;
async function call(name, input = {}) {
  const handler = tools.get(name);
  assert.ok(handler, `tool ${name} is not registered`);
  const result = await handler(input, { signal, reportProgress() {} });
  if (result.isError) {
    throw new Error(`${name} failed: ${result.content?.[0]?.text ?? 'unknown error'}`);
  }
  return result.structuredContent;
}

try {
  disposePlugin = await plugin.activate(context);
  assert.equal(tools.size, 14, `expected 14 tools, got ${tools.size}`);
  assert.ok(tools.has('office_sheets_ipc'), 'sheets IPC bridge is not registered');
  assert.ok(tools.has('office_sheets_open'), 'sheets library-open bridge is not registered');
  assert.ok(tools.has('office_slides_ipc'), 'slides IPC bridge is not registered');
  assert.ok(tools.has('office_slides_open'), 'slides library-open bridge is not registered');

  const docx = await call('document_create', {
    type: 'docx',
    name: 'Smoke.docx',
    source: '# Hello\n\nWorld from Matcha Office.\n\n- one\n- two\n'
  });
  assert.equal(docx.document.type, 'docx');
  const docxRead = await call('document_read', { documentId: docx.document.id });
  assert.equal(docxRead.preview.kind, 'docs');
  assert.match(docxRead.preview.html, /Hello/);
  const docxCheck = await call('document_check', { documentId: docx.document.id });
  assert.ok(docxCheck.document);
  const docxMd = await call('document_export', { documentId: docx.document.id, format: 'md' });
  assert.equal(docxMd.mimeType, 'text/markdown');

  const xlsx = await call('document_create', {
    type: 'xlsx',
    name: 'Smoke.xlsx',
    source: 'name,count\nalpha,1\nbeta,2\n',
    sourceFormat: 'csv'
  });
  assert.equal(xlsx.document.type, 'xlsx');
  const sheetRead = await call('document_read', { documentId: xlsx.document.id });
  assert.equal(sheetRead.preview.kind, 'sheets');
  assert.ok(sheetRead.preview.rows?.length >= 3, 'xlsx read returned no rows');
  const edited = await call('document_edit', {
    documentId: xlsx.document.id,
    expectedRevision: sheetRead.document.revision,
    cells: [{ cell: 'B2', value: 42 }]
  });
  assert.equal(edited.document.revision, sheetRead.document.revision + 1);
  const afterEdit = await call('document_read', { documentId: xlsx.document.id });
  assert.equal(String(afterEdit.preview.rows[1][1]), '42');
  const csv = await call('document_export', { documentId: xlsx.document.id, format: 'csv' });
  assert.equal(csv.mimeType, 'text/csv');

  const original = await call('document_export', { documentId: xlsx.document.id, format: 'original' });
  const opened = await call('office_sheets_open', {
    documentId: xlsx.document.id,
    name: 'Smoke.xlsx',
    data: original.data
  });
  assert.ok(opened.workbook?.sessionId, 'sheets session did not open');
  assert.ok(opened.workbook.sheets?.length >= 1, 'sheets session returned no worksheets');
  const read = await call('office_sheets_ipc', {
    channel: 'workbook:read-range',
    arguments: [{
      sessionId: opened.workbook.sessionId,
      sheetId: opened.workbook.sheets[0].id,
      range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }
    }]
  });
  assert.ok(read.result?.cells?.length >= 2, 'sheets range read returned no cells');

  const pptx = await call('document_create', {
    type: 'pptx',
    name: 'Smoke.pptx',
    source: '[]',
    sourceFormat: 'ops'
  });
  assert.equal(pptx.document.type, 'pptx');
  const deck = await call('document_read', { documentId: pptx.document.id });
  assert.equal(deck.preview.kind, 'slides');
  const audit = await call('document_check', { documentId: pptx.document.id });
  assert.ok(audit.document);
  const deckOriginal = await call('document_export', { documentId: pptx.document.id, format: 'original' });
  const openedDeck = await call('office_slides_open', {
    documentId: pptx.document.id,
    name: 'Smoke.pptx',
    data: deckOriginal.data
  });
  assert.ok(Array.isArray(openedDeck.presentation?.slides), 'slides session did not open');
  const savedDeck = await call('office_slides_ipc', { channel: 'slides:save', arguments: [] });
  assert.equal(savedDeck.result?.ok, true, 'slides save did not complete');
  const deckAfterSave = await call('document_read', { documentId: pptx.document.id });
  assert.ok(deckAfterSave.document.revision > deck.document.revision, 'slides save did not update the library revision');

  const list = await call('documents_list');
  assert.equal(list.documents.length, 3);
  const guide = await call('document_guide', { domain: 'docs' });
  assert.ok(guide.detail);

  await call('document_delete', { documentId: pptx.document.id });
  const afterDelete = await call('documents_list');
  assert.equal(afterDelete.documents.length, 2);

  console.log('Matcha Office engine smoke test passed.');
} finally {
  await disposePlugin?.();
  rmSync(storage, { recursive: true, force: true });
}
