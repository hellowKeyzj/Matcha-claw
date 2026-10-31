import type { Asset, ImageLayer } from './document';

export interface ExtractTextRequest {
  documentId: string;
  layerId: string;
  selectionId?: string;
}

export interface ExtractTextResult {
  texts: { marker: string; original: string }[];
  markedAsset: Asset;
  sourceLayerId: string;
  sourceAssetId: string;
  sourceCrop: ImageLayer['crop'] | null;
}

export type RecommendationKind = 'product-scene' | 'scene-video' | 'multi-shot';

export interface RecommendationRequest {
  documentId: string;
  sourceLayerIds: string[];
  /** Ordered independent references after the selected canvas sources. */
  referenceAssetIds?: string[];
  kind: RecommendationKind;
  language: string;
  refresh?: boolean;
}

export interface RecommendationResult {
  candidates: { id: string; title: string; description: string; prompt: string }[];
}
