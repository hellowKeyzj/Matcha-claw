import type { OpenedPptx } from '@genoffice/pptx-engine';

export interface SlidesSession {
  path: string;
  recoveryIdentityPath?: string;
  opened: OpenedPptx;
  fitWidthPx: number;
  metaDirty?: boolean;
  metaRev?: number;
}

export const sessions: Map<number, SlidesSession>;
export const viewerWcIds: Set<number>;
export function resetFontMetrics(): void;
export function getFontMetrics(): import('@genoffice/pptx-render').FontMetricsProvider;
export function buildAllRenderSlides(opened: OpenedPptx, fitWidthPx: number): import('@genoffice/pptx-render').RenderSlide[];
