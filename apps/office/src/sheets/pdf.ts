import type { AppRenderPdfRequest, AppRenderPdfResult } from '@matcha/app-plugins-sdk';
import { workbookExportPdfRequestSchema, type WorkbookExportPdfRequest } from '../../genoffice/apps/sheets/src/shared/desktop-api';
import { evenPageRanges, stitchPlan, type PageVariant } from '../../genoffice/apps/sheets/src/main/pdf-page-variants';
import { base64ToBytes } from '../documents/client';

type RenderPdf = (request: AppRenderPdfRequest) => Promise<AppRenderPdfResult>;
type Templates = Pick<WorkbookExportPdfRequest, 'headerTemplate' | 'footerTemplate'>;

/** Preserve upstream first/even-page passes through the real Host PDF service. */
export async function renderSheetsPdf(input: WorkbookExportPdfRequest, renderPdf: RenderPdf): Promise<Uint8Array> {
  const request = workbookExportPdfRequestSchema.parse(input);
  async function pass(templates?: Templates, pageRanges?: string) {
    const result = await renderPdf({ html: request.html, options: {
      landscape: request.landscape, pageSize: request.pageSize, margins: request.margins,
      scale: request.scale, preferCSSPageSize: true, printBackground: true,
      ...(pageRanges === undefined ? {} : { pageRanges }),
      ...(templates ? { displayHeaderFooter: true, headerTemplate: templates.headerTemplate ?? '<span></span>', footerTemplate: templates.footerTemplate ?? '<span></span>' } : {})
    } });
    if (result.mimeType !== 'application/pdf') throw new Error('PDF rendering returned an unexpected format.');
    const bytes = base64ToBytes(result.data);
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('PDF rendering returned invalid bytes.');
    return bytes;
  }
  const flags = { hasFirst: request.firstPage !== undefined, hasEven: request.evenPages !== undefined };
  const hasOdd = request.headerTemplate !== undefined || request.footerTemplate !== undefined;
  const odd = await pass(hasOdd ? request : flags.hasFirst || flags.hasEven ? {} : undefined);
  if (!flags.hasFirst && !flags.hasEven) return odd;
  const { PDFDocument } = await import('pdf-lib');
  const oddDocument = await PDFDocument.load(odd);
  const total = oddDocument.getPageCount();
  const passes: Partial<Record<PageVariant, typeof oddDocument>> = { odd: oddDocument };
  if (request.firstPage !== undefined && total >= 1) passes.first = await PDFDocument.load(await pass(request.firstPage, '1'));
  const evenRanges = evenPageRanges(total);
  if (request.evenPages !== undefined && evenRanges) passes.even = await PDFDocument.load(await pass(request.evenPages, evenRanges));
  const merged = await PDFDocument.create();
  for (const step of stitchPlan(total, flags)) {
    const source = passes[step.source];
    const [page] = source !== undefined && step.index < source.getPageCount()
      ? await merged.copyPages(source, [step.index]) : await merged.copyPages(oddDocument, [step.page - 1]);
    if (page) merged.addPage(page);
  }
  return merged.save();
}
