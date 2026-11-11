import type { AppDocumentResourcesRequest, AppPluginContext } from '@matcha/app-plugins-sdk';

export async function convertHtmlDocument(
  context: Pick<AppPluginContext, 'rendering'>,
  html: string,
  options: { format: 'docx' | 'png' | 'pdf'; naturalTableWidth?: boolean; document?: AppDocumentResourcesRequest },
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const { document, ...payload } = options;
  const result = await context.rendering.renderDocument({ ...(document ? { document } : { html }), entry: 'renderer/conversion-worker.js', payload }, signal);
  const expected = options.format === 'png' ? 'image/png' : options.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (result.mimeType !== expected) throw new Error('Document conversion returned an unexpected format.');
  const bytes = Buffer.from(result.data, 'base64');
  const signature = options.format === 'png' ? '89504e470d0a1a0a' : options.format === 'pdf' ? '255044462d' : '504b0304';
  if (!bytes.subarray(0, signature.length / 2).equals(Buffer.from(signature, 'hex'))) throw new Error('Document conversion returned invalid bytes.');
  return bytes;
}
