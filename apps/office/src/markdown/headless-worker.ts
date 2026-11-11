import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../genoffice/apps/markdown/src/renderer/editor/extensions';
import { parseMarkdownToNodes } from '../../genoffice/apps/markdown/src/renderer/editor/ops';
import { parseDocText } from '../../genoffice/apps/markdown/src/renderer/markdown/docText';
import { DOCX_MAX_IMAGE_PX, exportDocxBytes } from '../../genoffice/apps/markdown/src/renderer/export/docxExport';
import { toDocxImage } from '../../genoffice/apps/markdown/src/renderer/export/exportImage';
import { diagramLanguage, renderDiagram, diagramSvgToPng } from '../../genoffice/apps/markdown/src/renderer/editor/diagrams';
import { buildPrintHtml } from '../../genoffice/apps/markdown/src/renderer/export/printHtml';
import { exportImageMime } from '../../genoffice/apps/markdown/src/shared/export-image-mime';
import { selfContainedHtml } from './export';
import { bytesToBase64 } from '../documents/client';
import katex from 'katex';
import '../../genoffice/packages/ui/src/tokens.css';
import '../../genoffice/apps/markdown/src/renderer/styles.css';
import 'katex/dist/katex.min.css';

type Payload = { markdown: string; images: { source: string; base64: string; mime: string }[]; format: 'docx' | 'html' | 'pdf' };
export async function documentRenderer({ payload }: { payload?: Payload }, port: MessagePort): Promise<void> {
  if (!payload) throw new Error('Missing Markdown conversion input.');
  port.start();
  const editor = new Editor({ element: null, extensions: buildExtensions({ slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} }, slashItems: () => [] }), content: '' });
  try {
    const nodes = parseMarkdownToNodes(editor, parseDocText(payload.markdown).body);
    editor.commands.setContent({ type: 'doc', content: nodes.map(node => node.toJSON()) });
    const images = new Map(payload.images.map(image => [image.source, image]));
    let data: string;
    let mimeType: string;
    if (payload.format === 'docx') {
      const converted = new Map<string, NonNullable<Awaited<ReturnType<typeof toDocxImage>>>>();
      for (const [source, image] of images) {
        const mime = exportImageMime(image.mime);
        if (!mime) throw new Error(`Unsupported Markdown image: ${source}`);
        const result = await toDocxImage({ base64: image.base64, mime }, DOCX_MAX_IMAGE_PX);
        if (!result) throw new Error(`Could not convert Markdown image: ${source}`);
        converted.set(source, result);
      }
      const bytes = await exportDocxBytes(editor.getJSON(), async source => converted.get(source) ?? null, async (source, language) => {
        const diagram = await renderDiagram(language, source);
        return diagram.ok ? diagramSvgToPng(diagram.svg, DOCX_MAX_IMAGE_PX) : null;
      });
      data = bytesToBase64(bytes);
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    } else {
      const root = document.createElement('div');
      root.innerHTML = editor.getHTML();
      for (const formula of root.querySelectorAll<HTMLElement>('[data-type="inline-math"], [data-type="block-math"]')) katex.render(formula.dataset.latex ?? '', formula, { displayMode: formula.dataset.type === 'block-math', throwOnError: false });
      for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
        const source = image.getAttribute('src')!;
        const resource = images.get(source);
        if (!resource) throw new Error(`Missing Markdown image: ${source}`);
        image.src = `data:${resource.mime};base64,${resource.base64}`;
      }
      for (const code of root.querySelectorAll('pre > code')) {
        const language = diagramLanguage([...code.classList].find(value => value.startsWith('language-'))?.slice(9));
        if (!language) continue;
        const diagram = await renderDiagram(language, code.textContent ?? '');
        if (diagram.ok) { const preview = document.createElement('div'); preview.innerHTML = diagram.svg; code.parentElement!.replaceWith(preview); }
      }
      const html = await selfContainedHtml(buildPrintHtml(root, 'Markdown'), false);
      if (payload.format === 'pdf') {
        const result = await new Promise<{ data: string; mimeType: string }>((resolve, reject) => {
          port.onmessage = ({ data }) => { if (data.id !== 1) return; if (data.error) reject(new Error(data.error)); else resolve(data.result); };
          port.postMessage({ id: 1, type: 'pdf', input: { request: { html, options: { pageSize: 'A4', printBackground: true, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } } } } });
        });
        data = result.data; mimeType = result.mimeType;
      } else { data = bytesToBase64(new TextEncoder().encode(html)); mimeType = 'text/html'; }
    }
    port.postMessage({ type: 'result', input: { data, mimeType } });
  } catch (error) { console.error('[markdown] headless export failed:', error); port.postMessage({ type: 'error' }); }
  finally { editor.destroy(); port.close(); }
}
