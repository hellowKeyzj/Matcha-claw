import type { AppPluginContext } from '@matcha/app-plugins-sdk';
import { basename, extname } from 'node:path';
import type { DocumentContent, DocumentPreview, DocumentRecord, DocumentResource, DocumentType, EditorDocumentHooks } from './model';
import { createStore } from './store';
import { editInput } from './validation';
import { checkText, sourceText, textBytes } from './text';
import { convertDocument, renderDocument, type ConversionOptions } from './conversion';
import { OfficeError, errorMessage } from '../errors';
import { withTemp } from '../platform/temp';
import { configurePdfOcr } from '../pdf/ocr';
import {
  applyDocxOps,
  checkDocx,
  createDocxFromHtml,
  createDocxFromMarkdown,
  docxToMarkdown,
  docsGuide,
  readDocx
} from '../docs/engine';
import {
  applyXlsxCells,
  applyXlsxOps,
  checkXlsx,
  createXlsxFromCsv,
  createXlsxFromOps,
  openCsvWorkbook,
  readXlsx,
  sheetGuide,
  xlsxToCsv
} from '../sheets/engine';
import {
  applyPptxOps,
  auditPptx,
  createPptxFromOps,
  createPptxFromSpec,
  readPptx,
  slidesGuide
} from '../slides/engine';

const SLIDE_SIZE = { cx: 12192000, cy: 6858000 };

function summaryOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'summary' in value && typeof (value as { summary: unknown }).summary === 'string') {
    return (value as { summary: string }).summary;
  }
  return '';
}

export function createDocumentService(context: AppPluginContext) {
  configurePdfOcr(context.packagePath);
  const store = createStore(context.storagePath);

  async function publishChanged(document: DocumentRecord, revision: number | null = document.revision): Promise<void> {
    try {
      context.publish('document.changed', {
        documentId: document.id,
        revision,
        name: document.name,
        type: document.type
      });
    } catch (error) {
      context.log.error(`Committed ${document.id}, but change notification failed: ${errorMessage(error)}`);
    }
  }

  async function saveDocument(documentId: string, expectedRevision: number, produce: () => Promise<DocumentContent>, signal?: AbortSignal): Promise<number> {
    const document = await store.updateFrom(documentId, expectedRevision, produce, signal);
    await publishChanged(document);
    return document.revision;
  }

  function editorHooks(type: DocumentType): EditorDocumentHooks {
    return {
      saveDocument,
      async createDocument(name, produce, signal, libraryPath, documentType) {
        if (documentType !== undefined && (type !== 'xlsx' || documentType !== 'csv')) throw new OfficeError('invalid_request', 'Only Sheets can explicitly create CSV documents.');
        signal?.throwIfAborted();
        const produced = await produce();
        const content = produced instanceof Uint8Array ? { bytes: produced } : produced;
        const document = await store.create({ name, type: documentType ?? type, ...content, libraryPath }, signal);
        await publishChanged(document);
        return { documentId: document.id, revision: document.revision, name: document.name };
      },
      readDocument: store.read,
      readSnapshot: store.readSnapshot,
      async autoNameDocument(id, expectedRevision, baseName) {
        const document = await store.autoNameDocument(id, expectedRevision, baseName);
        if (document) await publishChanged(document);
        return document;
      },
      listDocuments: store.list,
      listResources: store.listResources,
      readResource: store.readResource,
      async putResource(id, expectedRevision, path, bytes, signal) {
        const document = await store.putResource(id, expectedRevision, path, bytes, signal);
        await publishChanged(document);
        return { revision: document.revision, path };
      },
      async moveDocument(id, expectedRevision, libraryPath, signal) {
        const document = await store.move(id, expectedRevision, libraryPath, signal);
        await publishChanged(document);
        return document;
      },
      logicalPath: (record) => `/library/${record.libraryPath ?? `${record.id}/${record.name}`}`
    };
  }

  async function create(input: {
    type: DocumentType;
    name: string;
    source: string;
    sourceFormat?: string;
    header?: boolean;
    resources?: readonly DocumentResource[];
    autoNamePending?: true;
  }): Promise<{ document: DocumentRecord; result: Record<string, unknown> }> {
    const format = input.sourceFormat ?? (input.type === 'docx' ? 'markdown' : input.type === 'xlsx' ? 'json' : input.type === 'csv' ? 'csv' : 'spec');
    let bytes: Uint8Array;
    let result: Record<string, unknown>;
    if (input.type === 'pdf') {
      const { createBlankPdf } = await import('../pdf/engine');
      bytes = await createBlankPdf();
      result = { summary: 'Created one A4 PDF page.', warnings: [] };
    } else if (input.type === 'csv') {
      if (format !== 'csv') throw new OfficeError('invalid_request', 'CSV creation requires CSV source.');
      bytes = textBytes(input.source);
      result = { summary: `Created ${input.name} from CSV.`, warnings: [] };
    } else if (input.type === 'md' || input.type === 'html' || input.type === 'txt' || input.type === 'json') {
      bytes = textBytes(input.source);
      result = { summary: `Created ${input.name}.`, warnings: [] };
    } else if (input.type === 'docx') {
      bytes = format === 'html'
        ? await createDocxFromHtml(input.source)
        : await createDocxFromMarkdown(input.source);
      result = { summary: `Created ${input.name} from ${format}.`, warnings: [] };
    } else if (input.type === 'xlsx') {
      if (format === 'csv') {
        bytes = await createXlsxFromCsv(new TextEncoder().encode(input.source));
        result = { summary: `Created ${input.name} from CSV.`, warnings: [] };
      } else {
        const parsed = JSON.parse(input.source) as unknown;
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const created = await createXlsxFromOps(list);
        bytes = created.bytes;
        result = { summary: `Applied ${list.length} workbook op(s).`, warnings: created.outcome.warnings };
      }
    } else if (format === 'ops') {
      const parsed = JSON.parse(input.source) as unknown;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const created = await createPptxFromOps(list);
      bytes = created.bytes;
      result = { summary: `Applied ${list.length} slide op(s).`, warnings: [] };
    } else {
      const deck = await withTemp(async (directory) => {
        const deck = await createPptxFromSpec(input.source, directory);
        return { bytes: new Uint8Array(deck.bytes), pages: deck.pages, issues: [...deck.issues] };
      });
      bytes = deck.bytes;
      result = { summary: `Built ${deck.pages} slide(s).`, warnings: deck.issues };
    }
    const document = await store.create({ name: input.name, type: input.type, bytes, resources: input.resources, autoNamePending: input.autoNamePending });
    await publishChanged(document);
    return { document, result };
  }

  async function importDocument(name: string, type: DocumentType, input: Uint8Array | { filePath: string }, resources?: readonly DocumentResource[], sourcePath?: string, signal?: AbortSignal): Promise<DocumentRecord> {
    const content = input instanceof Uint8Array ? { bytes: input } : input;
    const document = await store.create({ name, type, ...content, resources, sourcePath }, signal);
    await publishChanged(document);
    return document;
  }

  async function write(id: string, expectedRevision: number, input: Uint8Array | { filePath: string }, resources?: readonly DocumentResource[], signal?: AbortSignal): Promise<DocumentRecord> {
    const current = await store.get(id);
    if (resources !== undefined && current.type !== 'md' && current.type !== 'html') throw new OfficeError('invalid_request', 'resources are only supported for Markdown and HTML documents.');
    const content = input instanceof Uint8Array ? { bytes: input } : input;
    const document = await store.updateFrom(id, expectedRevision, async () => ({ ...content, resources }), signal);
    await publishChanged(document);
    return document;
  }

  async function preview(id: string, options: { full?: boolean; sheet?: string; range?: string; password?: string; from?: number; to?: number }): Promise<{ record: DocumentRecord; preview: DocumentPreview; resources: readonly DocumentResource[] }> {
    const { record, bytes, resources } = await store.read(id);
    let preview: DocumentPreview;
    if (record.type === 'md' || record.type === 'html' || record.type === 'txt' || record.type === 'json') {
      const text = new TextDecoder().decode(bytes);
      const maximum = 300_000;
      preview = { kind: 'text', text: text.slice(0, maximum), truncated: text.length > maximum };
    } else if (record.type === 'docx') {
      const read = await readDocx(bytes, options.full !== false, options.password);
      preview = {
        kind: 'docs', html: read.html, blocks: read.blocks, items: read.items, truncated: read.truncated,
        properties: read.properties, notes: read.notes, fields: read.fields, styles: read.styles,
        tableStyles: read.tableStyles, comments: read.comments, revisions: read.revisions, headerFooter: read.headerFooter
      };
    } else if (record.type === 'xlsx' || record.type === 'csv') {
      const workbook = record.type === 'csv' ? await openCsvWorkbook(bytes) : bytes;
      const read = await readXlsx(workbook, { sheet: options.sheet, range: options.range });
      preview = {
        kind: 'sheets',
        rows: read.rows,
        formulas: read.formulas,
        sheet: read.sheet,
        range: read.range,
        features: read.features as unknown as Readonly<Record<string, unknown>>,
        truncated: read.truncated
      };
    } else if (record.type === 'pptx') {
      const read = await readPptx(bytes, options.full !== false);
      preview = {
        kind: 'slides',
        size: (read.size as { cx: number; cy: number } | undefined) ?? SLIDE_SIZE,
        slides: read.pages as readonly unknown[],
        truncated: false
      };
    } else {
      const { readPdf } = await import('../pdf/engine');
      const read = await readPdf(bytes, { full: options.full !== false, password: options.password, from: options.from, to: options.to });
      preview = { kind: 'pdf', pages: read.pages, metadata: { ...read.info, pageCount: read.pageCount }, truncated: read.truncated };
    }
    return { record, preview, resources };
  }

  async function edit(id: string, expectedRevision: number, raw: Readonly<Record<string, unknown>>, resources?: readonly DocumentResource[]): Promise<{ document: DocumentRecord; result: Record<string, unknown> }> {
    const { record, bytes } = await store.read(id);
    if (record.revision !== expectedRevision) {
      throw new OfficeError('revision_conflict', `Revision conflict: current revision is ${record.revision}.`, { currentRevision: record.revision });
    }
    if (resources !== undefined && record.type !== 'md' && record.type !== 'html') throw new OfficeError('invalid_request', 'resources are only supported for Markdown and HTML documents.');
    if (raw.source !== undefined && record.type !== 'md' && record.type !== 'html' && record.type !== 'txt' && record.type !== 'json') throw new OfficeError('invalid_request', 'source is only supported for text document edits.');
    if (raw.pdf !== undefined && record.type !== 'pdf') throw new OfficeError('invalid_request', 'pdf is only supported for PDF edits.');
    if (record.type === 'pdf' && (raw.ops !== undefined || raw.cells !== undefined)) throw new OfficeError('invalid_request', 'PDF edits require pdf, not ops or cells.');
    const input = record.type === 'md' || record.type === 'html' || record.type === 'txt' || record.type === 'json' || record.type === 'pdf' ? {} : editInput(record, raw);
    let changed: Uint8Array;
    let result: Record<string, unknown>;
    if (record.type === 'pdf') {
      const validatePdfEdits: typeof import('../pdf/validation').validatePdfEdits = (await import('../pdf/validation')).validatePdfEdits;
      validatePdfEdits(raw.pdf);
      const { applyPdfEdits } = await import('../pdf/engine');
      const applied = await applyPdfEdits(bytes, raw.pdf);
      if (raw.pdf.redactions?.length) {
        const document = await store.createCopy(id, expectedRevision, `${basename(record.name, extname(record.name))}-redacted.pdf`, applied.bytes);
        await publishChanged(document);
        return { document, result: { summary: 'Saved permanent redactions to a new copy; source unchanged.', detail: applied.result, warnings: applied.warnings } };
      }
      changed = applied.bytes;
      result = { summary: 'Saved PDF edits.', detail: applied.result, warnings: applied.warnings };
    } else if (record.type === 'md' || record.type === 'html' || record.type === 'txt' || record.type === 'json') {
      if (raw.ops !== undefined || raw.cells !== undefined) throw new OfficeError('invalid_request', 'Text edits require source, not ops or cells.');
      changed = textBytes(sourceText(raw.source));
      result = { summary: 'Replaced document source.', warnings: [] };
    } else if (record.type === 'docx') {
      if (!input.ops) throw new OfficeError('invalid_request', 'docx edits require ops.');
      const applied = await applyDocxOps(bytes, input.ops);
      if (applied.outcome.failures.length) {
        const first = applied.outcome.failures[0];
        throw new OfficeError('invalid_request', `Op ${first.index} (${first.op}) was rejected.`, { failures: applied.outcome.failures });
      }
      changed = applied.bytes;
      result = {
        summary: `Applied ${applied.outcome.results.length} op(s).`,
        detail: { results: applied.outcome.results, skipped: applied.outcome.skipped },
        warnings: []
      };
    } else if (record.type === 'csv') {
      const workbook = await openCsvWorkbook(bytes);
      const applied = await applyXlsxCells(workbook, input.cells!);
      const output = await xlsxToCsv(applied.bytes);
      changed = textBytes(`\uFEFF${output.csv}`);
      result = { summary: `Wrote ${applied.outcome.cells} CSV cell(s).`, detail: applied.outcome, warnings: applied.outcome.warning ? [applied.outcome.warning] : [] };
    } else if (record.type === 'xlsx') {
      if (input.cells) {
        const applied = await applyXlsxCells(bytes, input.cells);
        changed = applied.bytes;
        result = {
          summary: `Wrote ${applied.outcome.cells} cell(s).`,
          detail: applied.outcome,
          warnings: applied.outcome.warning ? [applied.outcome.warning] : []
        };
      } else {
        if (!input.ops) throw new OfficeError('invalid_request', 'xlsx edits require cells or ops.');
        const applied = await applyXlsxOps(bytes, input.ops);
        changed = applied.bytes;
        result = {
          summary: `Applied ${applied.outcome.edits.length} edit(s).`,
          detail: { plan: applied.outcome.plan },
          warnings: applied.outcome.warnings
        };
      }
    } else if (record.type === 'pptx') {
      if (!input.ops) throw new OfficeError('invalid_request', 'pptx edits require ops.');
      const applied = await applyPptxOps(bytes, input.ops);
      changed = applied.bytes;
      result = { summary: `Applied ${input.ops.length} slide op(s).`, detail: applied.result, warnings: [] };
    } else {
      throw new OfficeError('unsupported', `Editing ${record.type} files is not supported.`);
    }
    const document = await store.updateFrom(id, expectedRevision, async () => ({ bytes: changed, resources }));
    await publishChanged(document);
    return { document, result };
  }

  async function check(id: string, password?: string): Promise<{ record: DocumentRecord; check: Record<string, unknown> }> {
    const { record, bytes, resources } = await store.read(id);
    let check: Record<string, unknown>;
    if (record.type === 'html') {
      const { checkHtml } = await import('../html/engine');
      const output = checkHtml(new TextDecoder().decode(bytes), resources);
      const warnings = [...output.errors.map((error) => error.code), ...output.missingResources.map((path) => `Missing resource: ${path}.`)];
      check = { summary: `${warnings.length} issue(s).`, detail: output, warnings };
    } else if (record.type === 'md') {
      const output = await checkText(new TextDecoder().decode(bytes), resources);
      check = { summary: `${output.issues.length} issue(s).`, detail: output, warnings: output.issues.map((issue) => issue.message) };
    } else if (record.type === 'txt' || record.type === 'json') {
      const warnings: string[] = [];
      if (record.type === 'json') {
        try { JSON.parse(new TextDecoder().decode(bytes)); }
        catch (error) { warnings.push(errorMessage(error)); }
      }
      check = { summary: `${warnings.length} issue(s).`, detail: {}, warnings };
    } else if (record.type === 'docx') {
      const issues = await checkDocx(bytes, password);
      check = { summary: `${issues.length} issue(s).`, detail: { issues }, warnings: [] };
    } else if (record.type === 'xlsx' || record.type === 'csv') {
      const output = await checkXlsx(record.type === 'csv' ? await openCsvWorkbook(bytes) : bytes);
      check = {
        summary: `${output.issues.length} issue(s).`,
        detail: output,
        warnings: output.issues.map((issue) => issue.message)
      };
    } else if (record.type === 'pptx') {
      const pages = await auditPptx(bytes);
      const issues = pages.flatMap((page) => page.issues ?? []);
      check = {
        summary: `${issues.length} issue(s) across ${pages.length} slide(s).`,
        detail: { pages },
        warnings: [...issues]
      };
    } else {
      const { checkPdf } = await import('../pdf/engine');
      const output = await checkPdf(bytes, password);
      check = { summary: `${output.pageCount} PDF page(s).`, detail: output, warnings: [] };
    }
    return { record, check };
  }

  async function exportDocument(id: string, format: 'original' | 'md' | 'csv'): Promise<{ record: DocumentRecord; exported: { name: string; mimeType: string; bytes: Uint8Array }; resources: readonly DocumentResource[] }> {
    const { record, bytes, resources } = await store.read(id);
    let exported: { name: string; mimeType: string; bytes: Uint8Array };
    if (format === 'original' || (format === 'csv' && record.type === 'csv')) {
      exported = { name: record.name, mimeType: record.mimeType, bytes };
    } else {
      const stem = basename(record.name, extname(record.name));
      if (format === 'md' && record.type === 'docx') {
        exported = { name: `${stem}.md`, mimeType: 'text/markdown', bytes: new TextEncoder().encode(await docxToMarkdown(bytes)) };
      } else if (format === 'csv' && record.type === 'xlsx') {
        const output = await xlsxToCsv(bytes);
        exported = { name: `${stem}.csv`, mimeType: 'text/csv', bytes: new TextEncoder().encode(output.csv) };
      } else {
        throw new OfficeError('unsupported', `Cannot export ${record.type} as ${format}.`);
      }
    }
    return { record, exported, resources };
  }

  async function convert(id: string, to: DocumentType, options: ConversionOptions & { name?: string } = {}) {
    const { record, bytes, resources } = await store.read(id);
    const converted = await convertDocument(record, bytes, resources, to, options, context);
    const name = options.name ?? (to === record.type ? record.name : `${basename(record.name, extname(record.name))}.${to}`);
    if (record.type === 'xlsx' && to === 'xlsx' && (extname(record.name).toLowerCase() === '.xlsm') !== (extname(name).toLowerCase() === '.xlsm')) throw new OfficeError('invalid_request', 'A workbook copy must preserve its native format; use a native Save As conversion.');
    const document = await store.create({ name, type: to, bytes: converted.bytes, resources: converted.resources }, options.signal);
    await publishChanged(document);
    return { source: record, document, warnings: converted.warnings };
  }

  async function render(id: string, options: { scale?: number; page?: number; password?: string; signal?: AbortSignal } = {}) {
    const { record, bytes, resources } = await store.read(id);
    const pdf = record.type === 'pdf' ? bytes : (await convertDocument(record, bytes, resources, 'pdf', options, context)).bytes;
    return { document: record, images: await renderDocument(pdf, options) };
  }

  async function remove(id: string): Promise<DocumentRecord> {
    const record = await store.get(id);
    await store.remove(id);
    await publishChanged(record, null);
    return record;
  }

  async function guide(domain: 'docs' | 'sheets' | 'slides'): Promise<Record<string, unknown>> {
    if (domain === 'docs') {
      const catalog = await docsGuide();
      return { domain, text: summaryOf(catalog), detail: catalog };
    }
    if (domain === 'sheets') {
      const catalog = await sheetGuide();
      return { domain, text: `${catalog.ops.length} workbook ops.`, detail: catalog };
    }
    const catalog = await slidesGuide();
    return { domain, text: catalog.text, detail: catalog.groups };
  }

  return { list: store.list, read: store.read, readSnapshot: store.readSnapshot, editorHooks, create, import: importDocument, write, preview, edit, check, export: exportDocument, remove, guide, convert, render };
}

export type DocumentService = ReturnType<typeof createDocumentService>;
