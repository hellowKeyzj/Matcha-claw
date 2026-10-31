import type { DesignDocument, ExportRequest, ExportResult } from '../document';
import type { Assets } from './assets';
import type { Documents } from './documents';
import { DesignError, requireRevision } from './files';
import { dimensions, invalid } from './validation';

export async function renderDocument(
  document: DesignDocument, assets: Assets, request: Pick<ExportRequest, 'format' | 'scale' | 'layerIds' | 'background'>, signal: AbortSignal,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  signal.throwIfAborted();
  const scale = request.scale ?? 1;
  const selected = request.layerIds && new Set(request.layerIds);
  if (selected) for (const layerId of selected) {
    if (!document.layers.some((layer) => layer.id === layerId)) invalid(`Export layer ${layerId} does not exist.`);
  }
  if (selected?.size && !document.layers.some((layer) => layer.visible && selected.has(layer.id))) {
    throw new DesignError('export_empty', 'The selected layers are hidden. Show at least one selected layer before exporting.');
  }
  const video = document.layers.find((layer) => layer.type === 'video' && layer.visible && (!selected || selected.has(layer.id)));
  if (video) throw new DesignError('unsupported_video_export', 'Image export cannot include video layers. Download the original video asset, or select only image and text layers.', { layerId: video.id });
  // Both browser and Node render the same scene; only the canvas backend differs.
  await import('konva/skia-backend');
  const [{ createScene }, { loadImage }, { default: Konva }] = await Promise.all([import('../scene'), import('skia-canvas'), import('konva')]);
  const images = new Map<string, unknown>();
  for (const layer of document.layers) {
    if (layer.type !== 'image' || !layer.visible || (selected && !selected.has(layer.id)) || images.has(layer.assetId)) continue;
    signal.throwIfAborted();
    const { bytes } = await assets.read(layer.assetId);
    signal.throwIfAborted();
    images.set(layer.assetId, await loadImage(bytes));
  }
  signal.throwIfAborted();
  const scene = createScene({ ...document, background: null }, images, request.layerIds);
  try {
    const bounds = scene.getClientRect();
    const x = bounds.width > 0 ? bounds.x : 0;
    const y = bounds.height > 0 ? bounds.y : 0;
    const contentWidth = bounds.width > 0 ? bounds.width : document.width;
    const contentHeight = bounds.height > 0 ? bounds.height : document.height;
    const width = Math.ceil(contentWidth * scale);
    const height = Math.ceil(contentHeight * scale);
    dimensions(width, height);
    const background = request.background ?? document.background ?? (request.format === 'jpeg' ? '#ffffff' : null);
    if (background) {
      const fill = new Konva.Rect({ x, y, width: width / scale, height: height / scale, fill: background, listening: false });
      scene.add(fill);
      fill.moveToBottom();
    }
    signal.throwIfAborted();
    scene.position({ x: -x, y: -y });
    const canvas = scene.toCanvas({ x: 0, y: 0, width: width / scale, height: height / scale,
      pixelRatio: scale }) as unknown as import('skia-canvas').Canvas;
    const bytes = await canvas.toBuffer(request.format);
    signal.throwIfAborted();
    return { bytes, width, height };
  } finally { scene.destroy(); }
}

export async function exportDocument(documents: Documents, assets: Assets, request: ExportRequest, signal: AbortSignal): Promise<ExportResult> {
  const document = await documents.get(request.documentId);
  requireRevision(document.revision, request.expectedRevision);
  const { bytes, width, height } = await renderDocument(document, assets, request, signal);
  signal.throwIfAborted();
  const suffix = `-r${document.revision}.${request.format}`;
  const asset = await assets.importBytes(`${document.name.slice(0, 200 - suffix.length)}${suffix}`, `image/${request.format}`, bytes, signal);
  return { asset, renderedRevision: document.revision, width, height };
}
