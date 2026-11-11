import type { RenderFill, RenderNode, RenderSlide } from '@genoffice/pptx-render';
import { buildPdfExportHtml, exportPageWidthIn, PDF_EXPORT_HEIGHT_IN } from '@matcha/slides-pdf-export';
import { renderSlidesToPdfPages } from '../../genoffice/apps/slides/src/renderer/export-pages';
import { collectExportPdfLinks } from '../../genoffice/apps/slides/src/renderer/export-links';
import { createImageLoader } from '../../genoffice/apps/slides/src/renderer/image-loader';
import { syncPrivateFonts } from '../../genoffice/apps/slides/src/renderer/doc-fonts';
import type { SlidesApi } from '../../genoffice/apps/slides/src/shared/ipc';
import '../../genoffice/apps/slides/src/renderer/styles.css';

type Font = { id: string; family: string; bold: boolean; italic: boolean; data: string };
type Payload = {
  slides: RenderSlide[];
  fonts: Font[];
  links: Awaited<ReturnType<SlidesApi['getSlideLinks']>>[];
  runLinks: Awaited<ReturnType<SlidesApi['getRunLinks']>>[];
};

/** Export aliases may share every font byte; keep their glyphs once in the print document. */
function deduplicateExportFonts(pages: Awaited<ReturnType<typeof renderSlidesToPdfPages>>): void {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(pages.fontCss);
  const rules = Array.from(sheet.cssRules) as CSSFontFaceRule[];
  const family = (rule: CSSFontFaceRule) => rule.style.getPropertyValue('font-family').trim().replace(/^['"]|['"]$/g, '');
  const signatures = new Map<string, string[]>();
  for (const rule of rules) {
    const name = family(rule);
    const faces = signatures.get(name) ?? [];
    faces.push(Array.from(rule.style).filter(key => key !== 'font-family').sort().map(key => `${key}:${rule.style.getPropertyValue(key)}`).join(';'));
    signatures.set(name, faces);
  }
  const canonical = new Map<string, string>();
  const aliases = new Map<string, string>();
  for (const [name, faces] of signatures) {
    const key = JSON.stringify(faces.sort());
    const first = canonical.get(key);
    if (first) aliases.set(name, first);
    else canonical.set(key, name);
  }
  if (!aliases.size) return;
  pages.fontCss = rules.filter(rule => !aliases.has(family(rule))).map(rule => rule.cssText).join('\n');
  for (const page of pages.pages) {
    if (!('svg' in page)) continue;
    const svg = new DOMParser().parseFromString(page.svg, 'image/svg+xml');
    for (const node of svg.querySelectorAll('[font-family]')) {
      const stack = (node.getAttribute('font-family') ?? '').split(',').map(part => {
        const name = part.trim().replace(/^['"]|['"]$/g, '');
        return aliases.has(name) ? JSON.stringify(aliases.get(name)) : part;
      });
      node.setAttribute('font-family', stack.join(','));
    }
    page.svg = new XMLSerializer().serializeToString(svg.documentElement);
  }
}

export async function documentRenderer({ payload }: { payload?: unknown }, port: MessagePort): Promise<void> {
  let loader: ReturnType<typeof createImageLoader> | undefined;
  try {
    const input = payload as Payload;
    const fonts = new Map(input.fonts.map(font => [font.id, font]));
    // The original font/export helpers need only these two read-only methods.
    Object.assign(window, { slidesApi: {
      privateFontFaces: async () => input.fonts,
      privateFontData: async (id: string) => {
        const font = fonts.get(id);
        return font ? Uint8Array.from(atob(font.data), char => char.charCodeAt(0)).buffer : null;
      }
    } });
    await syncPrivateFonts();
    await document.fonts.ready;
    const visibleIndexes = input.slides.flatMap((slide, index) => slide.hidden ? [] : [index]);
    const slides = visibleIndexes.map(index => input.slides[index]!);
    if (!slides.length) throw new Error('No visible slides to export.');
    const urls = new Set<string>();
    const fill = (value: RenderFill | undefined) => { if (value?.kind === 'image' && value.dataUrl) urls.add(value.dataUrl); };
    const text = (value: { lines: { runs: { image?: string }[] }[] } | undefined) => {
      for (const line of value?.lines ?? []) for (const run of line.runs) if (run.image) urls.add(run.image);
    };
    const walk = (nodes: readonly RenderNode[]) => {
      for (const node of nodes) {
        if (node.type === 'picture' && node.dataUrl) urls.add(node.dataUrl);
        if (node.type === 'shape' || node.type === 'text') { fill(node.fill); text(node.text); }
        if (node.type === 'chart') { fill(node.bgFill); for (const bar of node.bars) fill(bar.fill); }
        if (node.type === 'group') walk(node.children);
        if (node.type === 'table') for (const cell of node.cells) { fill(cell.fill); text(cell.text); }
      }
    };
    for (const slide of slides) { fill(slide.background); walk(slide.nodes); }
    const images = new Map<string, HTMLImageElement>();
    loader = createImageLoader(entries => { for (const [url, image] of entries) images.set(url, image); });
    loader.load(urls);
    const deadline = Date.now() + 60_000;
    while (loader.pending()) {
      if (Date.now() >= deadline) throw new Error('Slide images did not finish decoding.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (images.size !== urls.size) throw new Error('A slide image could not be decoded.');
    const pages = await renderSlidesToPdfPages(slides, images);
    deduplicateExportFonts(pages);
    const links = collectExportPdfLinks(slides, visibleIndexes.map(i => input.links[i]!), visibleIndexes.map(i => input.runLinks[i]!), new Map(visibleIndexes.map((index, page) => [index, page])));
    const html = buildPdfExportHtml(pages.pages, exportPageWidthIn(slides[0]!.widthPx, slides[0]!.heightPx), PDF_EXPORT_HEIGHT_IN, links, pages.fontCss);
    const bytes = new TextEncoder().encode(html);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    port.postMessage({ type: 'result', input: { data: btoa(binary), mimeType: 'text/html' } });
  } catch (error) {
    port.postMessage({ type: 'error', input: { message: error instanceof Error ? error.message : String(error) } });
  } finally { loader?.dispose(); port.close(); }
}
