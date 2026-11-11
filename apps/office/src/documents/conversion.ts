import type { AppPluginContext } from '@matcha/app-plugins-sdk';
import type { DocumentRecord, DocumentResource, DocumentType } from './model';
import { OfficeError } from '../errors';
import { textBytes } from './text';

export interface ConversionOptions {
  password?: string;
  sheet?: string;
  signal?: AbortSignal;
}

export async function convertDocument(
  record: DocumentRecord,
  bytes: Uint8Array,
  resources: readonly DocumentResource[],
  to: DocumentType,
  options: ConversionOptions = {},
  context: Pick<AppPluginContext, 'packagePath' | 'rendering'>
): Promise<{ bytes: Uint8Array; resources?: readonly DocumentResource[]; warnings: readonly string[] }> {
  options.signal?.throwIfAborted();
  if (record.type === to) return { bytes, resources, warnings: [] };
  if (record.type === 'pdf' && (to === 'docx' || to === 'xlsx' || to === 'pptx' || to === 'md' || to === 'html')) {
    const { convertPdf } = await import('../pdf/engine');
    const { exportDocsDocument } = await import('../docs/headless');
    return convertPdf(bytes, to, {
      password: options.password,
      onProgress: () => options.signal?.throwIfAborted(),
      exportDocument: (docx, format) => exportDocsDocument(context, docx, format, options.signal)
    });
  }
  if (record.type === 'csv' && (to === 'xlsx' || to === 'pdf')) {
    const { openCsvWorkbook, xlsxToPdf } = await import('../sheets/engine');
    const workbook = await openCsvWorkbook(bytes);
    options.signal?.throwIfAborted();
    return { bytes: to === 'xlsx' ? workbook : await xlsxToPdf(workbook, context, {}, options.signal), warnings: [] };
  }
  if (record.type === 'xlsx' && to === 'csv') {
    const { xlsxToCsv } = await import('../sheets/engine');
    const output = await xlsxToCsv(bytes, options.sheet);
    options.signal?.throwIfAborted();
    return { bytes: textBytes(`\uFEFF${output.csv}`), warnings: ['CSV preserves only the selected sheet’s displayed values; formulas, formatting and other workbook features are not retained.'] };
  }
  if (record.type === 'xlsx' && to === 'pdf') {
    const { xlsxToPdf } = await import('../sheets/engine');
    return { bytes: await xlsxToPdf(bytes, context, { password: options.password }, options.signal), warnings: [] };
  }
  if (record.type === 'pptx' && to === 'pdf') {
    const { pptxToPdf } = await import('../slides/engine');
    return { bytes: await pptxToPdf(context, bytes, options.signal), warnings: [] };
  }
  if (record.type === 'docx' && (to === 'md' || to === 'html' || to === 'pdf')) {
    const { exportDocsDocument } = await import('../docs/headless');
    return { bytes: await exportDocsDocument(context, bytes, to, options.signal, options.password), warnings: [] };
  }
  if (record.type === 'md' && (to === 'docx' || to === 'html' || to === 'pdf')) {
    const { exportMarkdownDocument } = await import('../markdown/headless');
    return { bytes: await exportMarkdownDocument(context, new TextDecoder().decode(bytes), resources, to, options.signal), warnings: [] };
  }
  if (record.type === 'html' && to === 'docx') {
    const { htmlToDocx } = await import('../html/engine');
    return { bytes: await htmlToDocx(context, new TextDecoder().decode(bytes), resources, options.signal, record.name), warnings: [] };
  }
  if (record.type === 'html' && (to === 'md' || to === 'pdf')) {
    const { htmlToMarkdown, htmlDocumentToPdf } = await import('../html/engine');
    const html = new TextDecoder().decode(bytes);
    return { bytes: to === 'md' ? textBytes(await htmlToMarkdown(html)) : await htmlDocumentToPdf(context, html, resources, options.signal, record.name), resources: to === 'md' ? resources : undefined, warnings: [] };
  }
  throw new OfficeError('unsupported', `Cannot convert ${record.type} to ${to}.`);
}

export async function renderDocument(bytes: Uint8Array, options: { scale?: number; page?: number; password?: string; signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const { rasterizePdf } = await import('../pdf/engine');
  const images = await rasterizePdf(bytes, options.scale ?? 1, options.page === undefined ? undefined : options.page - 1, options.password);
  options.signal?.throwIfAborted();
  return images.map((image) => ({ page: image.index + 1, width: image.width, height: image.height, mimeType: 'image/png' as const, data: Buffer.from(image.png).toString('base64') }));
}
