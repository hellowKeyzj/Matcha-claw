import Konva from 'konva';
import type { DesignDocument, ImageLayer } from './document';
import { applyImageAdjustments } from './image-adjustments';

interface RenderedImage {
  image: CanvasImageSource;
  width: number;
  height: number;
  paddingX: number;
  paddingY: number;
}

const adjustedImages = new WeakMap<object, Map<string, RenderedImage>>();
const maxEffectBytes = 512 * 1024 * 1024;

function effectsKey(layer: ImageLayer): string | undefined {
  const adjustments = layer.adjustments;
  const stroke = layer.stroke && layer.stroke.width > 0 && layer.stroke.opacity > 0 ? layer.stroke : undefined;
  if (!stroke && (!adjustments || !Object.values(adjustments).some(Boolean))) return undefined;
  return JSON.stringify([adjustments?.blur ?? 0, adjustments?.brightness ?? 0, adjustments?.contrast ?? 0,
    adjustments?.hue ?? 0, adjustments?.saturation ?? 0, adjustments?.invert ?? false,
    stroke?.color, stroke?.width, stroke?.opacity]);
}

function dilateAlpha({ data, width, height }: ImageData, radius: number): void {
  const alpha = new Uint8Array(width * height);
  const queue = new Int32Array(width);
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    const value = alpha[index] = data[index * 4 + 3];
    if (!value) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  data.fill(0);
  if (right < left) return;
  // Flat disk max-alpha dilation, not source-over stamps that accumulate translucent alpha.
  // Sliding row maxima keep this O(radius * expanded alpha bounds), rather than O(radius² * canvas pixels).
  for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
    const span = Math.abs(dy) <= radius ? Math.floor(Math.sqrt(radius * radius - dy * dy)) : -1;
    if (span >= 0) for (let y = top; y <= bottom; y++) {
      const source = y * width;
      const target = (y + dy) * width;
      let head = 0, tail = 0, next = left;
      for (let x = left - span; x <= right + span; x++) {
        const end = Math.min(right, x + span);
        for (; next <= end; next++) {
          while (tail > head && alpha[source + queue[tail - 1]] <= alpha[source + next]) tail--;
          queue[tail++] = next;
        }
        while (head < tail && queue[head] < x - span) head++;
        const index = (target + x) * 4 + 3;
        data[index] = Math.max(data[index], alpha[source + queue[head]]);
      }
    }
    // A one-pixel coverage fringe retains fractional widths; only O(radius) kernel offsets lie here.
    const edge = Math.floor(Math.sqrt((radius + 1) ** 2 - dy * dy));
    for (let dx = span + 1; dx <= edge; dx++) {
      const coverage = Math.min(1, radius + 1 - Math.hypot(dx, dy));
      if (coverage <= 0) continue;
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const value = alpha[y * width + x] * coverage;
        if (!value) continue;
        const first = ((y + dy) * width + x - dx) * 4 + 3;
        const second = ((y + dy) * width + x + dx) * 4 + 3;
        data[first] = Math.max(data[first], value);
        data[second] = Math.max(data[second], value);
      }
    }
  }
}

function adjustedImage(image: CanvasImageSource, layer: ImageLayer, budget: { bytes: number }): RenderedImage {
  const source = image as HTMLImageElement;
  const width = source.naturalWidth ?? source.width;
  const height = source.naturalHeight ?? source.height;
  const key = effectsKey(layer);
  if (!key) return { image, width, height, paddingX: 0, paddingY: 0 };
  const adjustments = layer.adjustments;
  const stroke = layer.stroke && layer.stroke.width > 0 && layer.stroke.opacity > 0 ? layer.stroke : undefined;
  let variants = adjustedImages.get(image);
  const existing = variants?.get(key);
  if (existing) return existing;

  const outlinePadding = stroke ? Math.ceil(stroke.width + 1) : 0;
  const outlinedWidth = width + outlinePadding * 2, outlinedHeight = height + outlinePadding * 2;
  const blur = (adjustments?.blur ?? 0) / 100 * 0.12;
  // Fix support before padding: padding must contain the blur, not feed back into its radius.
  const blurRadius = Math.min(outlinedWidth, outlinedHeight) * blur;
  const paddingX = outlinePadding + Math.ceil(outlinedWidth * blur);
  const paddingY = outlinePadding + Math.ceil(outlinedHeight * blur);
  const outputWidth = width + paddingX * 2, outputHeight = height + paddingY * 2;
  // Apply the existing canvas ceiling before allocating the canvas and filter buffers.
  if (outputWidth > 32768 || outputHeight > 32768 || outputWidth * outputHeight > 64 * 1024 * 1024) {
    throw new Error('Image effects exceed the 32768-pixel edge or 64-megapixel canvas limit.');
  }
  const canvasBytes = outputWidth * outputHeight * 4;
  const buffers = adjustments && Object.values(adjustments).some(Boolean) ? (blurRadius ? 3 : 2) : 1;
  const strokeBytes = stroke ? canvasBytes * 2 + outputWidth * outputHeight + outputWidth * 4 : 0;
  // Budget retained canvases plus peak ImageData/alpha/deque or filter scratch before allocation.
  if (budget.bytes + Math.max(canvasBytes * buffers, strokeBytes) > maxEffectBytes) throw new Error('Image effects exceed the 512 MiB pixel-buffer budget.');
  const canvas = Konva.Util.createCanvasElement();
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Image effects require a 2D canvas.');
  if (stroke) {
    context.drawImage(image, paddingX, paddingY);
    const pixels = context.getImageData(0, 0, outputWidth, outputHeight);
    dilateAlpha(pixels, stroke.width);
    context.putImageData(pixels, 0, 0);
    context.globalCompositeOperation = 'source-in';
    context.globalAlpha = stroke.opacity;
    context.fillStyle = stroke.color;
    context.fillRect(0, 0, outputWidth, outputHeight);
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
  }
  context.drawImage(image, paddingX, paddingY);
  // Outline and transparent padding precede filters; crop and viewport changes reuse these pixels.
  if (adjustments && Object.values(adjustments).some(Boolean)) {
    const pixels = context.getImageData(0, 0, outputWidth, outputHeight);
    applyImageAdjustments(pixels, adjustments, blurRadius);
    context.putImageData(pixels, 0, 0);
  }
  const result = { image: canvas, width, height, paddingX, paddingY };
  if (!variants) adjustedImages.set(image, variants = new Map());
  variants.set(key, result);
  budget.bytes += canvasBytes;
  return result;
}

function imageNode(properties: Omit<Konva.ImageConfig, 'image'>, layer: ImageLayer, rendered: RenderedImage): Konva.Image {
  const node = new Konva.Image({ ...properties, image: rendered.image,
    ...(layer.crop ? { crop: layer.crop } : {}),
    ...(layer.shadow ? { shadowColor: layer.shadow.color, shadowBlur: layer.shadow.blur,
      shadowOffsetX: layer.shadow.offsetX, shadowOffsetY: layer.shadow.offsetY,
      shadowOpacity: layer.shadow.opacity } : {}),
  });
  const crop = layer.crop ?? { x: 0, y: 0, width: rendered.width, height: rendered.height };
  // Only asset edges expose padding: an internal crop edge must not reveal discarded neighboring pixels.
  const left = crop.x === 0 ? rendered.paddingX : 0;
  const top = crop.y === 0 ? rendered.paddingY : 0;
  const right = crop.x + crop.width === rendered.width ? rendered.paddingX : 0;
  const bottom = crop.y + crop.height === rendered.height ? rendered.paddingY : 0;
  node.getSelfRect = () => ({
    x: -(layer.flipX ? right : left) * node.width() / crop.width,
    y: -(layer.flipY ? bottom : top) * node.height() / crop.height,
    width: (crop.width + left + right) * node.width() / crop.width,
    height: (crop.height + top + bottom) * node.height() / crop.height,
  });
  node.sceneFunc((context) => {
    const width = node.width(), height = node.height();
    // Keep node geometry positive; only the pixels flip around the layer's center.
    context.save();
    context.translate(layer.flipX ? width : 0, layer.flipY ? height : 0);
    context.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
    context.drawImage(rendered.image,
      crop.x + rendered.paddingX - left, crop.y + rendered.paddingY - top,
      crop.width + left + right, crop.height + top + bottom,
      -left * width / crop.width, -top * height / crop.height,
      (crop.width + left + right) * width / crop.width, (crop.height + top + bottom) * height / crop.height);
    context.restore();
  });
  return node;
}

export function createScene(
  document: DesignDocument,
  images: ReadonlyMap<string, unknown>,
  layerIds?: readonly string[],
): Konva.Layer {
  const scene = new Konva.Layer();
  const used = new Map<object, Set<string>>();
  const budget = { bytes: 0 };
  try {
    const selected = layerIds ? new Set(layerIds) : null;
    for (const layer of document.layers) {
      if (layer.type !== 'image' || !layer.visible || (selected && !selected.has(layer.id))) continue;
      const image = images.get(layer.assetId) as object | undefined;
      const key = effectsKey(layer);
      if (!image || !key) continue;
      let keys = used.get(image);
      if (!keys) used.set(image, keys = new Set());
      keys.add(key);
    }
    // Prune obsolete slider/history variants before allocating their replacements.
    for (const image of new Set(images.values())) {
      const variants = adjustedImages.get(image as object);
      if (!variants) continue;
      const keys = used.get(image as object);
      for (const [key, rendered] of variants) {
        if (!keys?.has(key)) variants.delete(key);
        else {
          const canvas = rendered.image as HTMLCanvasElement;
          budget.bytes += canvas.width * canvas.height * 4;
        }
      }
      if (!variants.size) adjustedImages.delete(image as object);
    }
    if (budget.bytes > maxEffectBytes) throw new Error('Image effects exceed the 512 MiB pixel-buffer budget.');
    if (document.background) {
      scene.add(new Konva.Rect({
        width: document.width, height: document.height,
        fill: document.background, listening: false,
      }));
    }
    for (const layer of document.layers) {
      if (!layer.visible || (selected && !selected.has(layer.id))) continue;
      const properties = {
        id: layer.id, x: layer.x, y: layer.y, width: layer.width, height: layer.height,
        rotation: layer.rotation, opacity: layer.opacity,
        draggable: !layer.locked, listening: !layer.locked,
      };
      if (layer.type === 'image' || layer.type === 'video') {
        const image = images.get(layer.assetId) as Konva.ImageConfig['image'];
        if (!image) throw new Error(`${layer.type === 'video' ? 'Video poster' : 'Image'} asset is not loaded: ${layer.assetId}`);
        scene.add(layer.type === 'image'
          ? imageNode(properties, layer, adjustedImage(image, layer, budget))
          : new Konva.Image({ ...properties, image }));
      } else {
        scene.add(new Konva.Text({
          ...properties, text: layer.text, fontFamily: layer.fontFamily,
          fontSize: layer.fontSize, fontStyle: layer.fontStyle, fill: layer.fill,
          align: layer.align, lineHeight: layer.lineHeight,
        }));
      }
    }
    return scene;
  } catch (error) {
    scene.destroy();
    throw error;
  }
}
