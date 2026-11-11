import type { AppPluginContext } from '@matcha/app-plugins-sdk';
import type { DocumentResource } from '../documents/model';
import { withMarkdownEditor, imageResource } from './engine';
import { imageMime } from './export';

export async function exportMarkdownDocument(context: Pick<AppPluginContext, 'rendering'>, markdown: string, resources: readonly DocumentResource[], format: 'docx' | 'html' | 'pdf', signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const images = await withMarkdownEditor(markdown, async editor => {
    const sources = new Set<string>();
    editor.state.doc.descendants(node => { if (node.type.name === 'image') sources.add(String(node.attrs.src)); });
    return Promise.all([...sources].map(async source => {
      const resource = await imageResource(source, resources);
      if (!resource) throw new Error(`Missing Markdown image: ${source}`);
      return { source, base64: Buffer.from(resource.bytes).toString('base64'), mime: imageMime(resource.path) };
    }));
  });
  const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer/markdown-headless-worker.css"></head><body></body></html>';
  const result = await context.rendering.renderDocument({ html, entry: 'renderer/markdown-headless-worker.js', payload: { markdown, images, format } }, signal);
  const expected = format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : format === 'pdf' ? 'application/pdf' : 'text/html';
  if (result.mimeType !== expected) throw new Error('Markdown conversion returned an unexpected format.');
  const bytes = Buffer.from(result.data, 'base64');
  if (!bytes.length || format === 'pdf' && bytes.subarray(0, 5).toString() !== '%PDF-' || format === 'docx' && bytes.subarray(0, 4).toString('hex') !== '504b0304') throw new Error('Markdown conversion returned invalid bytes.');
  return bytes;
}
