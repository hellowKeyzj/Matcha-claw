import type { Canvas } from 'skia-canvas';
import type { Asset, ImageLayer } from '../document';
import { dimensions, invalid } from './validation';

export interface ImageInput {
  bytes: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
  canvas?: Canvas;
}

export function imageInputKey(assetId: string, crop: ImageLayer['crop']): string {
  return JSON.stringify([assetId, crop ? [crop.x, crop.y, crop.width, crop.height] : null]);
}

export async function prepareImageInput(source: { asset: Asset; bytes: Buffer }, crop: ImageLayer['crop'], signal: AbortSignal): Promise<ImageInput> {
  signal.throwIfAborted();
  if (!crop && ['image/png', 'image/jpeg', 'image/webp'].includes(source.asset.mimeType)) {
    return { bytes: source.bytes, mimeType: source.asset.mimeType, width: source.asset.width, height: source.asset.height };
  }
  const { Canvas, loadImage } = await import('skia-canvas');
  signal.throwIfAborted();
  const image = await loadImage(source.bytes);
  signal.throwIfAborted();
  dimensions(image.width, image.height);
  if (crop && (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > image.width || crop.y + crop.height > image.height)) invalid(`Layer crop exceeds image asset ${source.asset.id} bounds.`);
  const width = crop ? Math.max(1, Math.round(crop.width)) : image.width;
  const height = crop ? Math.max(1, Math.round(crop.height)) : image.height;
  dimensions(width, height);
  const canvas = new Canvas(width, height);
  const drawing = canvas.getContext('2d');
  if (crop) drawing.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  else drawing.drawImage(image, 0, 0);
  const bytes = await canvas.toBuffer('png');
  signal.throwIfAborted();
  return { bytes, mimeType: 'image/png', width, height, canvas };
}
