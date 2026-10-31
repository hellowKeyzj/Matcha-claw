import type { GenerationRequest } from '../document';
import { DesignError } from './files';

export const aspectRatios = ['1:1', '4:5', '5:4', '9:16', '16:9', '4:3', '3:4', '2:3', '3:2', '21:9'] as const;

export function targetSize(request: GenerationRequest, source: { width?: number; height?: number }): { width: number; height: number } | undefined {
  if (request.action !== 'resize' && request.action !== 'upscale') return undefined;
  const { width, height } = source;
  if (!width || !height) throw new DesignError('invalid_input', 'The source image must have measured dimensions.');
  let targetWidth: number;
  let targetHeight: number;
  if (request.action === 'resize') {
    const [horizontal, vertical] = request.aspectRatio!.split(':').map(Number);
    targetWidth = Math.sqrt(width * height * horizontal / vertical);
    targetHeight = Math.sqrt(width * height * vertical / horizontal);
    const maximum = Math.max(targetWidth, targetHeight);
    if (maximum > 4096) { targetWidth *= 4096 / maximum; targetHeight *= 4096 / maximum; }
  } else {
    targetWidth = width * 2;
    targetHeight = height * 2;
    const maximum = Math.max(targetWidth, targetHeight);
    if (maximum > 2048) { targetWidth *= 2048 / maximum; targetHeight *= 2048 / maximum; }
  }
  const minimum = Math.min(targetWidth, targetHeight);
  if (minimum < 256) {
    const scale = 256 / minimum;
    if (Math.max(targetWidth, targetHeight) * scale > 4096) throw new DesignError('invalid_input', 'The source aspect ratio cannot meet the 256–4096 pixel target bounds.');
    targetWidth *= scale;
    targetHeight *= scale;
  }
  return { width: Math.min(Math.ceil(targetWidth / 16) * 16, 4096), height: Math.min(Math.ceil(targetHeight / 16) * 16, 4096) };
}
