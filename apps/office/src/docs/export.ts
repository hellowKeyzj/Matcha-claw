import type { DesktopApi } from './types';
import { PDFDocument } from 'pdf-lib';
import { zipSync } from 'fflate';
import { addPdfInternalLinks } from '../../genoffice/apps/docs/src/main/pdf-links';
import { embeddedFontExportCss } from '../../genoffice/apps/docs/src/renderer/embedded-fonts';
import { appApi, base64ToBytes, bytesToBase64 } from '../documents/client';
import { downloadFile } from '../ui/files';

type ExportMethods = Pick<DesktopApi, 'exportPdf' | 'printPdfBuffer' | 'saveMergedPdf' | 'pickExportImagesTarget' | 'takeExportPdf' | 'writeExportImage' | 'exportHtml'>;

async function dataUrl(url: string): Promise<string> {
  if (url.startsWith('data:')) return url;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to read export resource: ${url}`);
  const data = bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  return `data:${response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream'};base64,${data}`;
}

async function inlineCss(css: string, base: string): Promise<string> {
  const urls = [...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)];
  for (const match of urls) {
    const value = match[2]!;
    if (!value || value.startsWith('#') || value.startsWith('data:')) continue;
    css = css.split(match[0]).join(`url("${await dataUrl(new URL(value, base).href)}")`);
  }
  return css;
}

async function inlineElements(root: ParentNode): Promise<void> {
  await Promise.all([...root.querySelectorAll('img, image, [style]')].map(async (element) => {
    if (element instanceof HTMLImageElement) {
      element.removeAttribute('srcset');
      if (element.src) element.src = await dataUrl(element.src);
    } else if (element.localName === 'image') {
      const src = element.getAttribute('href') ?? element.getAttribute('xlink:href');
      if (src && !src.startsWith('#')) {
        element.removeAttribute('xlink:href');
        element.setAttribute('href', await dataUrl(new URL(src, document.baseURI).href));
      }
    }
    const style = element.getAttribute('style');
    if (style) element.setAttribute('style', await inlineCss(style, document.baseURI));
  }));
}

async function printHtml(widthTwips: number, heightTwips: number): Promise<string> {
  await document.fonts.ready;
  const preview = document.querySelector<HTMLElement>('.pagination-preview');
  if (!preview) throw new Error('The document pagination preview is not ready.');
  const clone = preview.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.pv-print-skip, .pv-toolbar, img.ProseMirror-separator:not([src])').forEach((element) => element.remove());
  clone.querySelectorAll('script, iframe, object, embed').forEach((element) => element.remove());
  if (!clone.querySelector('.pv-page')) throw new Error('There are no document pages to export.');
  const css: string[] = [embeddedFontExportCss()];
  const loadedFonts = [...document.fonts].filter((font) => font.status === 'loaded');
  async function rulesFor(rules: CSSRuleList, base: string): Promise<void> {
    for (const rule of rules) {
      if (rule instanceof CSSImportRule) {
        if (rule.styleSheet) await rulesFor(rule.styleSheet.cssRules, rule.href);
      } else {
        if (rule instanceof CSSFontFaceRule) {
          const family = rule.style.getPropertyValue('font-family').replace(/["']/g, '');
          if (!loadedFonts.some((font) => font.family.replace(/["']/g, '') === family)) continue;
        }
        css.push(await inlineCss(rule.cssText, base));
      }
    }
  }
  for (const sheet of document.styleSheets) await rulesFor(sheet.cssRules, sheet.href ?? document.baseURI);
  await inlineElements(clone);
  css.push(`@page { size: ${widthTwips / 1440}in ${heightTwips / 1440}in; margin: 0; }`);
  // Keep the upstream print CSS, document variables, section styles and zoom together.
  const html = document.documentElement.cloneNode(false) as HTMLElement;
  const head = document.createElement('head');
  const charset = document.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  const style = document.createElement('style');
  style.textContent = css.join('\n');
  head.append(charset, style);
  const body = document.body.cloneNode(false) as HTMLElement;
  const app = document.querySelector('.app')?.cloneNode(false) as HTMLElement | undefined;
  if (!app) throw new Error('The document application is not ready.');
  app.classList.remove('pv-exporting');
  app.append(clone);
  body.append(app);
  html.append(head, body);
  return `<!doctype html>${html.outerHTML}`;
}

export function createDocsExports(output?: (bytes: Uint8Array, mimeType: string) => void, renderPdf = (request: Parameters<NonNullable<Window['matchaApp']>['renderPdf']>[0]) => appApi().renderPdf(request)): ExportMethods {
  const imageTargets = new Map<string, { dir: string; pdf?: Uint8Array; count?: number; images: Record<string, Uint8Array> }>();
  const errorResult = (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
  const pdfName = (name: string) => name.replace(/\.(docx|pdf)$/i, '') + '.pdf';

  async function render(width: number, height: number, scale = 1): Promise<string> {
    const result = await renderPdf({
      html: await printHtml(width, height),
      options: { pageSize: { width: width / 1440, height: height / 1440 }, margins: { top: 0, bottom: 0, left: 0, right: 0 }, scale, printBackground: true, preferCSSPageSize: true }
    });
    return result.data;
  }

  const saveMergedPdf: DesktopApi['saveMergedPdf'] = async (name, parts, outPath, links) => {
    try {
      const target = outPath ? imageTargets.get(outPath) : undefined;
      if (outPath && !target && !output && outPath !== 'office-download:pdf') throw new Error('The export target is no longer available.');
      const pdf = await PDFDocument.create();
      for (const part of parts) {
        const source = await PDFDocument.load(base64ToBytes(part));
        for (const page of await pdf.copyPages(source, source.getPageIndices())) pdf.addPage(page);
      }
      if (links?.length) addPdfInternalLinks(pdf, links);
      const bytes = await pdf.save();
      if (target) { target.pdf = bytes; target.count = pdf.getPageCount(); return { ok: true, path: outPath }; }
      if (output) { output(bytes, 'application/pdf'); return { ok: true, path: outPath }; }
      return downloadFile(pdfName(name), bytes, 'application/pdf');
    } catch (error) { return errorResult(error); }
  };

  return {
    printPdfBuffer: async (width, height, scale) => {
      try { return { ok: true, base64: await render(width, height, scale) }; }
      catch (error) { return errorResult(error); }
    },
    exportPdf: async (name, width, height, outPath, scale, links) => {
      try { return await saveMergedPdf(name, [await render(width, height, scale)], outPath, links); }
      catch (error) { return { ...errorResult(error), path: outPath ?? 'office-download:pdf' }; }
    },
    saveMergedPdf,
    pickExportImagesTarget: async () => {
      imageTargets.clear();
      const id = crypto.randomUUID();
      const dir = `images-${id}`;
      const pdfPath = `office-export:${id}`;
      imageTargets.set(pdfPath, { dir, images: {} });
      return { dir, pdfPath };
    },
    takeExportPdf: async (path) => {
      const target = imageTargets.get(path);
      if (!target?.pdf) { imageTargets.delete(path); return { ok: false, error: 'The image export PDF is not available.' }; }
      const base64 = bytesToBase64(target.pdf);
      delete target.pdf;
      return { ok: true, base64 };
    },
    writeExportImage: async (dir, name, base64) => {
      try {
        const entry = [...imageTargets].find(([, target]) => target.dir === dir);
        if (!entry) throw new Error('The image export target is no longer available.');
        const [path, target] = entry;
        const safeName = name.split(/[\\/]/).pop()!;
        target.images[safeName] = base64ToBytes(base64);
        if (Object.keys(target.images).length === target.count) {
          const archiveName = safeName.replace(/-\d+\.png$/i, '') + '-images.zip';
          downloadFile(archiveName, zipSync(target.images), 'application/zip');
          imageTargets.delete(path);
        }
        return { ok: true, path: `${dir}/${safeName}` };
      } catch (error) { return errorResult(error); }
    },
    exportHtml: async (name, source, outPath) => {
      try {
        if (outPath && !output) throw new Error('Explicit filesystem export is unavailable.');
        const html = new DOMParser().parseFromString(source, 'text/html');
        await inlineElements(html);
        const fonts = html.createElement('style');
        fonts.textContent = embeddedFontExportCss();
        html.head.append(fonts);
        const bytes = new TextEncoder().encode(`<!doctype html>${html.documentElement.outerHTML}`);
        if (output) { output(bytes, 'text/html'); return { ok: true, path: outPath }; }
        const nameWithoutExtension = name.replace(/\.(docx|html)$/i, '');
        return downloadFile(`${nameWithoutExtension}.html`, bytes, 'text/html');
      } catch (error) { return errorResult(error); }
    }
  };
}
