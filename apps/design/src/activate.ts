import { randomUUID } from 'node:crypto';
import type { AppPluginContext, AppToolContext, AppToolHandler, AppToolResult } from '@matcha/app-plugins-sdk';
import type { ImageLayer } from './document';
import { createAssets, decodeBase64 } from './backend/assets';
import { createAnalysis, extractTextRequest, recommendationRequest } from './backend/analysis';
import { createDocuments, parseSessionIdentity } from './backend/documents';
import { editComposeOperation } from './backend/compose';
import { exportDocument } from './backend/export';
import { DesignError, errorMessage } from './backend/files';
import { createGenerations } from './backend/generation';
import { createTemplates } from './backend/templates';
import { change, exportRequest, generationRequest, id, invalid, number, object, revision, text } from './backend/validation';

function result(summary: string, structuredContent: Record<string, unknown>): AppToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent };
}

export async function activate(context: AppPluginContext): Promise<() => Promise<void>> {
  const assets = createAssets(context.storagePath, context.packagePath);
  const documents = createDocuments(context.storagePath, assets,
    (document) => context.publish('document.changed', { documentId: document.id, revision: document.revision }));
  const generations = createGenerations(context, documents, assets);
  const analysis = createAnalysis(context, documents, assets);
  const templates = createTemplates(context.storagePath, assets);
  let focus: { documentId: string; layerId: string } | undefined;
  await generations.initialize();
  const disposers: (() => void)[] = [];
  const active = new Set<Promise<AppToolResult>>();
  function register(name: string, handler: (input: Readonly<Record<string, unknown>>, tool: AppToolContext) => Promise<AppToolResult>): void {
    const checked: AppToolHandler = async (input, tool) => {
      try { tool.signal.throwIfAborted(); return await handler(input, tool); } catch (error) {
        const message = errorMessage(error);
        return { content: [{ type: 'text', text: message }], isError: true,
          structuredContent: { code: error instanceof DesignError ? error.code : tool.signal.aborted ? 'interrupted' : 'operation_failed',
            error: message, ...(error instanceof DesignError ? error.details : {}) } };
      }
    };
    disposers.push(context.registerTool(name, async (input, tool) => {
      const operation = checked(input, tool);
      active.add(operation);
      try { return await operation; } finally { active.delete(operation); }
    }));
  }
  register('documents_list', async (input) => {
    const raw = object(input, ['sessionIdentity']);
    const entries = await documents.list(parseSessionIdentity(raw.sessionIdentity));
    return result(`${entries.length} design documents.`, { documents: entries });
  });
  register('document_create', async (input) => {
    const raw = object(input, ['name', 'width', 'height', 'sessionIdentity']);
    const document = await documents.create(raw.name === undefined ? undefined : text(raw.name, 'name', 200),
      raw.width === undefined ? undefined : number(raw.width, 'width', 1, 32768),
      raw.height === undefined ? undefined : number(raw.height, 'height', 1, 32768), parseSessionIdentity(raw.sessionIdentity));
    return result(`Created ${document.name}.`, { document, ...(focus?.documentId === document.id ? { focusLayerId: focus.layerId } : {}) });
  });
  register('image_open', async (input, tool) => {
    const raw = object(input, ['sessionIdentity', 'name', 'mimeType', 'data']);
    const sessionIdentity = parseSessionIdentity(raw.sessionIdentity);
    if (!sessionIdentity) invalid('image_open requires a complete sessionIdentity.');
    const name = text(raw.name, 'name', 200);
    const mimeType = text(raw.mimeType, 'mimeType', 100);
    if (!mimeType.startsWith('image/')) invalid('image_open requires an image.');
    const asset = await assets.importByContent(name, mimeType, decodeBase64(raw.data, 64 * 1024 * 1024), tool.signal);
    tool.signal.throwIfAborted();
    const workspace = await documents.create('画板', undefined, undefined, sessionIdentity);
    await import('konva/skia-backend');
    const { default: Konva } = await import('konva');
    tool.signal.throwIfAborted();
    const opened = await documents.openAsset(workspace.id, (current) => {
      const bounds = current.layers.filter((layer) => layer.visible).map((layer) => {
        const node = new Konva.Rect({ x: layer.x, y: layer.y, width: layer.width, height: layer.height, rotation: layer.rotation });
        const bounds = node.getClientRect();
        node.destroy();
        return bounds;
      });
      const layer: ImageLayer = { id: randomUUID(), type: 'image', assetId: asset.id, name: asset.name,
        x: bounds.length ? Math.max(...bounds.map((rect) => rect.x + rect.width)) + 24 : 0,
        y: bounds.length ? Math.min(...bounds.map((rect) => rect.y)) : 0,
        width: asset.width!, height: asset.height!, rotation: 0, opacity: 1, visible: true, locked: false, lockAspectRatio: true };
      return layer;
    });
    focus = { documentId: opened.document.id, layerId: opened.layerId };
    context.publish('document.focus', focus);
    return result(`Opened ${asset.name} in ${opened.document.name}.`, { ...opened });
  });
  register('document_get', async (input) => {
    const raw = object(input, ['documentId']);
    const document = await documents.get(id(raw.documentId, 'documentId'));
    return result(`${document.name}, revision ${document.revision}.`, { document, ...(focus?.documentId === document.id ? { focusLayerId: focus.layerId } : {}) });
  });
  register('document_edit', async (input) => {
    const document = await documents.edit(change(input));
    return result(`Saved revision ${document.revision}.`, { document });
  });
  for (const direction of ['undo', 'redo'] as const) register(`document_${direction}`, async (input) => {
    const raw = object(input, ['documentId', 'expectedRevision']);
    const document = await documents.travel(id(raw.documentId, 'documentId'), revision(raw.expectedRevision), direction);
    return result(`${direction === 'undo' ? 'Undid' : 'Redid'} edit; revision ${document.revision}.`, { document });
  });
  register('asset_import', async (input, tool) => {
    const raw = object(input, ['name', 'mimeType', 'data']);
    const mimeType = text(raw.mimeType, 'mimeType', 100);
    const asset = await assets.importByContent(text(raw.name, 'name', 200), mimeType, decodeBase64(raw.data, (mimeType.startsWith('image/') ? 64 : 256) * 1024 * 1024), tool.signal);
    return result(`Imported ${asset.name}.`, { asset });
  });
  register('asset_read', async (input) => {
    const raw = object(input, ['assetId']);
    const { asset, bytes } = await assets.read(id(raw.assetId, 'assetId'));
    return result(`${asset.name} (${asset.mimeType}).`, { asset, data: bytes.toString('base64') });
  });
  register('document_export', async (input, tool) => {
    const exported = await exportDocument(documents, assets, exportRequest(input), tool.signal);
    return result(`Exported revision ${exported.renderedRevision} (${exported.width}×${exported.height}).`, { ...exported });
  });
  register('media_models', async (input, tool) => {
    const raw = object(input, ['kind']);
    if (raw.kind !== 'image' && raw.kind !== 'video') invalid('kind must be image or video.');
    const models = await context.models.list({ kind: raw.kind }, tool.signal);
    return result(`${models.models.length} media models.`, { ...models });
  });
  register('generate', async (input, tool) => {
    const generated = await generations.generate(generationRequest(input), tool);
    return result(`Generation completed; ${generated.generation.assets.length} assets saved.`, { ...generated });
  });
  register('compose_edit', async (input) => result('Updated design draft references.', editComposeOperation(input)));
  register('text_extract', async (input, tool) => {
    const extracted = await analysis.extractText(extractTextRequest(input), tool.signal);
    return result(`Recognized ${extracted.texts.length} text regions.`, { ...extracted });
  });
  register('recommendations', async (input, tool) => {
    const recommended = await analysis.recommend(recommendationRequest(input), tool.signal);
    return result(`${recommended.candidates.length} recommendations.`, { ...recommended });
  });
  register('templates', async (input, tool) => {
    const catalog = await templates.run(input, tool.signal);
    return result(`${catalog.templates.length} local templates.`, { ...catalog });
  });
  register('generation_cancel', async (input) => {
    const raw = object(input, ['documentId', 'generationId']);
    const cancelled = await generations.cancel(id(raw.documentId, 'documentId'), id(raw.generationId, 'generationId'));
    return result(`Generation ${cancelled.generation.state}.`, { ...cancelled });
  });
  register('generations_list', async (input) => {
    const raw = object(input, ['documentId']);
    const entries = await generations.list(id(raw.documentId, 'documentId'));
    return result(`${entries.length} generation records.`, { generations: entries });
  });
  return async () => {
    for (const dispose of disposers.reverse()) dispose();
    await Promise.all([generations.close(), analysis.close()]);
    await Promise.allSettled([...active]);
    await Promise.all([documents.drain(), templates.drain()]);
  };
}
