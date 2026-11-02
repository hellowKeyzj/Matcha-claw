import type { IabBounds } from '../../../src/types/desktop/iab';

/** Renderer rects are CSS pixels; native views and the unzoomed tools viewport use DIP. */
export function iabBoundsToDip(bounds: IabBounds, zoomFactor: number): IabBounds {
  const x = Math.round(bounds.x * zoomFactor);
  const y = Math.round(bounds.y * zoomFactor);
  return { x, y, width: Math.max(0, Math.round((bounds.x + bounds.width) * zoomFactor) - x),
    height: Math.max(0, Math.round((bounds.y + bounds.height) * zoomFactor) - y) };
}
