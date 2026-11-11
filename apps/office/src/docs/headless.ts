import type { AppJson, AppPluginContext } from '@matcha/app-plugins-sdk';
import { familyVerticalMetrics } from '../../genoffice/packages/font-metrics/src/metrics';
import { text } from '../documents/validation';
import { loadDocxZip } from '../../genoffice/packages/docx-engine/src/zip-load';
import { altChunkKind, decodeHtmlBytes, decodeMhtToHtml } from '../../genoffice/packages/docx-engine/src/alt-chunk';
import { resolveRelationshipTargetPath } from '../../genoffice/packages/docx-engine/src/parse-package';
import { convertHtmlDocument } from '../conversion';
import { decryptDocx, isEncryptedDocx } from '../../genoffice/apps/docs/src/main/docx-encryption';

/** Convert chunks before mounting the App: the HTML converter owns a separate renderer. */
async function altChunks(context: Pick<AppPluginContext, 'packagePath' | 'rendering'>, bytes: Uint8Array, signal?: AbortSignal): Promise<Record<string, string>> {
  const { ensureDom } = await import('../platform/replacements/dom');
  await ensureDom();
  const zip = await loadDocxZip(bytes);
  const xml = (text: string) => new DOMParser().parseFromString(text, 'application/xml');
  const types = xml(await zip.file('[Content_Types].xml')!.async('string'));
  const overrides = new Map([...types.getElementsByTagNameNS('*', 'Override')].map(node => [node.getAttribute('PartName')!.replace(/^\//, ''), node.getAttribute('ContentType')!]));
  const defaults = new Map([...types.getElementsByTagNameNS('*', 'Default')].map(node => [node.getAttribute('Extension')!, node.getAttribute('ContentType')!]));
  const result: Record<string, string> = {};
  for (const relFile of Object.values(zip.files)) {
    if (relFile.dir || !/\/_rels\/[^/]+\.rels$/.test(relFile.name)) continue;
    const source = relFile.name.replace('/_rels/', '/').replace(/\.rels$/, '');
    const rels = xml(await relFile.async('string'));
    for (const rel of rels.getElementsByTagNameNS('*', 'Relationship')) {
      if (!/\/aFChunk$/.test(rel.getAttribute('Type') ?? '') || rel.getAttribute('TargetMode') === 'External') continue;
      const path = resolveRelationshipTargetPath(source, rel.getAttribute('Target') ?? '');
      if (!path) continue;
      const part = zip.file(path);
      if (!part) continue;
      const data = await part.async('uint8array');
      if (!data.length || data.length > 64 * 1024 * 1024) continue;
      const kind = altChunkKind(path, overrides.get(path) ?? defaults.get(path.split('.').pop()!), data.subarray(0, 4096));
      const html = kind === 'html' ? decodeHtmlBytes(data) : kind === 'mht' ? decodeMhtToHtml(data) : null;
      if (!html?.trim() || Object.hasOwn(result, html)) continue;
      const converted = await convertHtmlDocument(context, html, { format: 'docx', naturalTableWidth: true }, signal);
      result[html] = Buffer.from(converted).toString('base64');
    }
  }
  return result;
}

export async function exportDocsDocument(
  context: Pick<AppPluginContext, 'packagePath' | 'rendering'>,
  bytes: Uint8Array,
  format: 'pdf' | 'html' | 'md',
  signal?: AbortSignal,
  password?: string,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (isEncryptedDocx(Buffer.from(bytes))) {
    if (!password) throw new Error('A password is required to export this Word document.');
    bytes = await decryptDocx(Buffer.from(bytes), password);
    signal?.throwIfAborted();
  }
  const chunks = await altChunks(context, bytes, signal);
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="renderer/docs-headless-worker.css"></head><body><div id="root"></div></body></html>';
  const result = await context.rendering.renderDocument({ entry: 'renderer/docs-headless-worker.js', html, payload: {
    data: Buffer.from(bytes).toString('base64'), format, chunks,
  } }, signal, async (input): Promise<AppJson> => {
    signal?.throwIfAborted();
    return familyVerticalMetrics(text(input, 'family', 200)) as unknown as AppJson;
  });
  const mimeType = format === 'pdf' ? 'application/pdf' : format === 'html' ? 'text/html' : 'text/markdown';
  if (result.mimeType !== mimeType) throw new Error('Docs export returned an unexpected format.');
  const output = Buffer.from(result.data, 'base64');
  if (!output.length || format === 'pdf' && output.subarray(0, 5).toString() !== '%PDF-') throw new Error('Docs export returned invalid bytes.');
  return output;
}
