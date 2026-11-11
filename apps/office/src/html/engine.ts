import { parse } from 'parse5';
import type { AppPluginContext, AppRenderPdfRequest, AppRenderPdfResult } from '@matcha/app-plugins-sdk';
import { convertHtmlDocument } from '../conversion';
import type { DocumentResource } from '../documents/model';
import { decodeBytes, documentSnapshot, projectHtml } from './resources';

export function checkHtml(source: string, resources: readonly DocumentResource[] = []) {
  const errors: { code: string; line?: number; column?: number }[] = [];
  parse(source, { onParseError(error) { errors.push({ code: error.code, line: error.startLine, column: error.startCol }); } });
  const projection = projectHtml(source, resources);
  return { ok: errors.length === 0 && projection.missing.length === 0, errors, missingResources: projection.missing };
}
export async function htmlToPdf(
  html: string,
  resources: readonly DocumentResource[],
  renderPdf: (request: AppRenderPdfRequest, signal?: AbortSignal) => Promise<AppRenderPdfResult>,
  signal?: AbortSignal
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const projected = projectHtml(html, resources);
  if (projected.missing.length) throw new Error(`Missing document resources: ${projected.missing.join(', ')}`);
  const result = await renderPdf({ html: projected.html, options: { pageSize: 'A4', printBackground: true,
    margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } } }, signal);
  return decodeBytes(result.data);
}
export async function htmlDocumentToPdf(context: Pick<AppPluginContext, 'rendering'>, html: string, resources: readonly DocumentResource[] = [], signal?: AbortSignal, name = 'index.html'): Promise<Uint8Array> {
  return convertHtmlDocument(context, html, { format: 'pdf', document: documentSnapshot(html, resources, name) }, signal);
}
export async function htmlToDocx(context: Pick<AppPluginContext, 'rendering'>, html: string, resources: readonly DocumentResource[] = [], signal?: AbortSignal, name = 'index.html'): Promise<Uint8Array> {
  return convertHtmlDocument(context, html, { format: 'docx', document: documentSnapshot(html, resources, name) }, signal);
}
export async function htmlToImage(context: Pick<AppPluginContext, 'rendering'>, html: string, resources: readonly DocumentResource[] = [], signal?: AbortSignal, name = 'index.html'): Promise<Uint8Array> {
  return convertHtmlDocument(context, html, { format: 'png', document: documentSnapshot(html, resources, name) }, signal);
}
export async function htmlToMarkdown(html: string): Promise<string> {
  const { htmlToMarkdown: convert } = await import('../../genoffice/packages/cli/src/formats/markdown');
  return convert(html);
}
