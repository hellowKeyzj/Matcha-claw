import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTemp } from '../platform/temp';
import { validatePdfEdits } from './validation';
import type { SavePdfRequest } from '../../genoffice/apps/pdf/src/shared/ipc';
import type { ReadPdfTextOptions } from '../../genoffice/apps/pdf/src/main/read-text';
import type { PdfiumModule } from '../../genoffice/packages/pdf2docx/src/extract/pdfium';

export async function createBlankPdf(): Promise<Uint8Array> {
  const { blankPdfBuffer } = await import('../../genoffice/apps/pdf/src/main/blank-pdf');
  return new Uint8Array(await blankPdfBuffer());
}

export async function readPdf(bytes: Uint8Array, options: ReadPdfTextOptions & { full?: boolean; from?: number; to?: number } = {}) {
  const { readPdfText } = await import('../../genoffice/apps/pdf/src/main/read-text');
  return readPdfText(bytes, { ...options, fromPage: options.from ?? options.fromPage, toPage: options.to ?? options.toPage, charBudget: options.charBudget ?? (options.full ? undefined : 300_000) });
}

export async function pdfInfo(bytes: Uint8Array, password?: string) {
  const result = await readPdf(bytes, { password, charBudget: 0 });
  return { pageCount: result.pageCount, metadata: result.info };
}

export async function applyPdfEdits(bytes: Uint8Array, request: Omit<SavePdfRequest, 'path' | 'targetPath'>) {
  validatePdfEdits(request);
  return withTemp(async (directory) => {
    const source = join(directory, 'source.pdf');
    const target = join(directory, 'saved.pdf');
    await writeFile(source, bytes);
    const { savePdfToPath } = await import('../../genoffice/apps/pdf/src/main/save-pdf');
    const result = await savePdfToPath(source, target, { ...request, path: source, targetPath: target });
    return { bytes: new Uint8Array(await readFile(target)), result, warnings: [...result.skippedTextEdits, ...result.skippedTextInserts, ...result.skippedImageEdits] };
  });
}

export async function checkPdf(bytes: Uint8Array, password?: string) {
  const read = await readPdf(bytes, { password, full: true });
  const { readPdfSignatures } = await import('../../genoffice/apps/pdf/src/main/pdf-signatures');
  const signatures = await readPdfSignatures(bytes);
  return { pageCount: read.pageCount, metadata: read.info, signatures, pages: read.pages.map(({ page, widthPt, heightPt, hasTextLayer }) => ({ page, widthPt, heightPt, hasTextLayer })) };
}

export async function convertPdf(bytes: Uint8Array, target: 'docx' | 'pptx' | 'xlsx' | 'md' | 'html', options: { password?: string; onProgress?: (page: number, total: number) => void; exportDocument?: (bytes: Uint8Array, format: 'html' | 'md') => Promise<Uint8Array> } = {}) {
  const { loadPdfium, chainPdfium } = await import('../../genoffice/apps/pdf/src/main/text-edit');
  const convert = await import('../../genoffice/packages/pdf2docx/src');
  const { getPdfOcrEngine } = await import('./ocr');
  const pdfium = await loadPdfium() as unknown as PdfiumModule;
  return chainPdfium(async () => {
    const opts = { ...options, pdfium, ocr: getPdfOcrEngine() ?? undefined };
    if (target === 'pptx') {
      const { pptx: output, ...result } = await convert.convertPdfToPptx(bytes, opts);
      return { bytes: output, ...result };
    }
    if (target === 'xlsx') {
      const { xlsx: output, ...result } = await convert.convertPdfToXlsx(bytes, opts);
      return { bytes: output, ...result };
    }
    const { docx, ...result } = await convert.convertPdfToDocx(bytes, opts);
    if (target === 'docx') return { bytes: docx, ...result };
    if (!options.exportDocument) throw new Error('The native Docs exporter is required for PDF HTML/Markdown conversion.');
    return { bytes: await options.exportDocument(docx, target), ...result };
  });
}

export async function rasterizePdf(bytes: Uint8Array, scale = 1, only?: number, password?: string) {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error('PDF render scale must be greater than zero and at most four.');
  const { loadPdfium, chainPdfium, withDocument } = await import('../../genoffice/apps/pdf/src/main/text-edit');
  const { renderPageByIndexPng } = await import('../../genoffice/packages/pdf2docx/src/extract');
  return chainPdfium(async () => {
    const module = await loadPdfium();
    return withDocument(module, bytes, async (document) => {
      const count = module._FPDF_GetPageCount(document);
      if (only !== undefined && (!Number.isInteger(only) || only < 0 || only >= count)) throw new Error('PDF page is out of range.');
      const output: { index: number; png: Uint8Array; width: number; height: number }[] = [];
      for (const index of only === undefined ? Array.from({ length: count }, (_, index) => index) : [only]) {
        const rendered = renderPageByIndexPng(module as unknown as PdfiumModule, document, index, scale);
        if (!rendered) throw new Error(`Could not render PDF page ${index + 1}.`);
        output.push({ index, png: rendered.data, width: rendered.pixelWidth, height: rendered.pixelHeight });
      }
      return output;
    }, password);
  });
}
