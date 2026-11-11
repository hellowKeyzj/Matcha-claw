import type { ApplyOptions, DeckSummary } from '../../genoffice/packages/cli/src/formats/pptx';
import type { Op, TxnResult } from '../../genoffice/packages/pptx-ops/src';
import { OfficeError } from '../errors';
import type { AppJson, AppPluginContext } from '@matcha/app-plugins-sdk';
import type { DeckAuditPage } from '../../genoffice/packages/pipelines/src/slides/audit-deck';

export async function createPptxFromSpec(
  spec: string,
  directory: string
): Promise<{ bytes: Uint8Array; pages: number; issues: readonly string[] }> {
  const [slides, images, { default: sharp }, { HeuristicMetrics }] = await Promise.all([
    import('../../genoffice/packages/pipelines/src/slides/deck-spec'),
    import('../../genoffice/packages/cli/src/formats/image-source'),
    import('sharp'),
    import('../../genoffice/packages/pptx-render/src/metrics')
  ]);
  const parsed = slides.parseDeckSpec(spec, { localImages: true });
  if (!parsed.ok) throw new Error(parsed.error);
  const metrics = new HeuristicMetrics();
  const dimensions = new Map<Uint8Array, { width: number; height: number }>();
  const built = await slides.buildDeckPptx(parsed.spec, {
    fetchImage: async (url: string) => {
      const source = await images.readImageSource(url, { cwd: directory, env: process.env }, directory);
      if (!source) return null;
      const size = await sharp(source.bytes, { limitInputPixels: 48_000_000 }).metadata();
      if (!size.width || !size.height) return null;
      dimensions.set(source.bytes, { width: size.width, height: size.height });
      return { bytes: source.bytes, ext: source.ext };
    },
    imageDims: (bytes: Uint8Array) => dimensions.get(bytes) ?? null,
    fontMetrics: metrics
  });
  return {
    bytes: built.bytes,
    pages: parsed.spec.pages.length,
    issues: [
      ...parsed.issues.map((issue) => JSON.stringify(issue)),
      ...built.imageFailures.map((failure) => JSON.stringify({ kind: 'image-failure', ...failure })),
      ...built.imageWarnings.map((warning) => JSON.stringify({ kind: 'image-warning', ...warning }))
    ]
  };
}

function requireApplied(result: TxnResult): void {
  if (!result.applied || result.failures?.length) {
    throw new OfficeError('invalid_request', result.failures?.[0]?.error ?? 'No slide operations were applied.', { failures: result.failures ?? [] });
  }
}

export async function createPptxFromOps(ops: readonly unknown[]): Promise<{ bytes: Uint8Array; result: unknown }> {
  const pptx = await import('../../genoffice/packages/cli/src/formats/pptx');
  const opened = await pptx.blankDeck();
  // An empty create request intentionally creates the blank template.
  const result = ops.length ? pptx.applyOps(opened, ops as Op[], {}) : { applied: true, records: [] };
  requireApplied(result);
  return { bytes: await pptx.saveDeck(opened), result };
}

export async function importPresentation(source: Uint8Array, extension: 'ppt' | 'odp' | 'otp'): Promise<{ bytes: Uint8Array; detail: Record<string, unknown> }> {
  if (extension === 'ppt') {
    const { convertLegacyPpt } = await import('../../genoffice/packages/cli/src/formats/legacy-ppt');
    return convertLegacyPpt(source);
  }
  const { convertOdp } = await import('../../genoffice/packages/cli/src/formats/odf');
  return convertOdp(source);
}

export async function pptxToPdf(
  context: Pick<AppPluginContext, 'rendering'>,
  source: Uint8Array,
  signal?: AbortSignal
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const [pptx, state, fonts, { listEmbeddedFonts, getSlideLinks, getRunLinks }, { shapedMetricsReady }, { initFontStore }, { listMetafileFonts }] = await Promise.all([
    import('../../genoffice/packages/cli/src/formats/pptx'),
    import('@matcha/slides-session-state'),
    import('../../genoffice/apps/slides/src/main/fonts'),
    import('@genoffice/pptx-engine'),
    import('../../genoffice/apps/slides/src/main/shaped-metrics'),
    import('../../genoffice/apps/slides/src/main/font-store'),
    import('../../genoffice/apps/slides/src/main/metafile-fonts')
  ]);
  initFontStore();
  await shapedMetricsReady();
  const opened = await pptx.openDeck(source);
  try {
    if (fonts.registerEmbeddedFonts(listEmbeddedFonts(opened.archive))) state.resetFontMetrics();
  } catch { /* Match the editor: malformed embedded fonts retain the fallback. */ }
  try {
    const metrics = state.getFontMetrics();
    for (const font of listMetafileFonts(opened.archive)) metrics.displayFamily?.({ fontFamily: font.family, fontSizePx: 100, bold: font.bold, italic: font.italic });
  } catch { /* Match the editor's best-effort metafile-font adoption. */ }
  const slides = state.buildAllRenderSlides(opened, 1280);
  const visible = slides.find(slide => !slide.hidden);
  if (!visible) throw new Error('No visible slides to export.');
  const privateFonts = fonts.listPrivateFontFaces().flatMap(font => {
    const bytes = fonts.getPrivateFontData(font.id);
    return bytes ? [{ ...font, data: Buffer.from(bytes).toString('base64') }] : [];
  });
  const rendered = await context.rendering.renderDocument({
    entry: 'renderer/export-worker.js',
    html: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer/export-worker.css"></head><body></body></html>',
    payload: {
      slides,
      fonts: privateFonts,
      links: slides.map((_, index) => getSlideLinks(opened, index).map(({ elementId, target }) => ({ sourceId: elementId, target }))),
      runLinks: slides.map((_, index) => getRunLinks(opened, index).map(({ elementId, ...rest }) => ({ sourceId: elementId, ...rest })))
    } as unknown as AppJson
  }, signal);
  if (rendered.mimeType !== 'text/html') throw new Error('Slide rendering returned an unexpected format.');
  const { exportPageWidthIn, PDF_EXPORT_HEIGHT_IN } = await import('@matcha/slides-pdf-export');
  const pdf = await context.rendering.renderPdf({
    html: Buffer.from(rendered.data, 'base64').toString('utf8'),
    options: { landscape: false, printBackground: true, pageSize: { width: exportPageWidthIn(visible.widthPx, visible.heightPx), height: PDF_EXPORT_HEIGHT_IN }, margins: { top: 0, bottom: 0, left: 0, right: 0 }, preferCSSPageSize: false }
  }, signal);
  const bytes = Buffer.from(pdf.data, 'base64');
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('PDF rendering returned invalid bytes.');
  return bytes;
}

export async function readPptx(source: Uint8Array, full: boolean): Promise<DeckSummary> {
  const pptx = await import('../../genoffice/packages/cli/src/formats/pptx');
  const opened = await pptx.openDeck(source);
  return pptx.describeDeck(opened, undefined, full);
}

export async function applyPptxOps(
  source: Uint8Array,
  ops: readonly unknown[],
  options: ApplyOptions = {}
): Promise<{ bytes: Uint8Array; result: unknown }> {
  const pptx = await import('../../genoffice/packages/cli/src/formats/pptx');
  const opened = await pptx.openDeck(source);
  const result = pptx.applyOps(opened, ops as Op[], options);
  requireApplied(result);
  return { bytes: await pptx.saveDeck(opened), result };
}

export async function parsePptxOps(text: string): Promise<Op[]> {
  const pptx = await import('../../genoffice/packages/cli/src/formats/pptx');
  return pptx.parseOps(text, 'ops.json');
}

export async function slidesGuide(): Promise<{ text: string; groups: Readonly<Record<string, unknown>> }> {
  const { opSignatureIndex, OP_GUIDES } = await import('../../genoffice/packages/pptx-ops/src');
  return { text: opSignatureIndex(), groups: OP_GUIDES };
}

export async function auditPptx(source: Uint8Array): Promise<readonly DeckAuditPage[]> {
  const { auditDeck } = await import('../../genoffice/packages/pipelines/src/slides/audit-deck');
  return auditDeck(source);
}
