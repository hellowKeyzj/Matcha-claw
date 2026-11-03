import type { SessionIdentity } from '@matcha/app-plugins-sdk';

export interface LayerProperties {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
}

export interface ImageLayer extends LayerProperties {
  type: 'image';
  assetId: string;
  /** Half-open rectangle in original asset pixels; asset bytes remain unchanged. */
  crop?: { x: number; y: number; width: number; height: number };
  flipX?: boolean;
  flipY?: boolean;
  lockAspectRatio?: boolean;
  adjustments?: { blur: number; brightness: number; contrast: number; hue: number; saturation: number; invert: boolean };
  stroke?: { color: string; width: number; opacity: number };
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number; opacity: number };
}

export interface VideoLayer extends LayerProperties {
  type: 'video';
  assetId: string;
}

export interface TextLayer extends LayerProperties {
  type: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  fontStyle: 'normal' | 'bold' | 'italic' | 'bold italic';
  fill: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
}

export type Layer = ImageLayer | VideoLayer | TextLayer;
export type LayerPatch = Partial<Omit<ImageLayer, 'id' | 'type'>> & Partial<Omit<VideoLayer, 'id' | 'type'>> & Partial<Omit<TextLayer, 'id' | 'type'>>;

export interface Asset {
  id: string;
  name: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  posterAssetId?: string;
  contentHash?: string;
}

export interface DesignDocument {
  schemaVersion: 1;
  id: string;
  /** Workspace binding is retained across undo/redo without changing the content revision. */
  sessionIdentity?: SessionIdentity;
  revision: number;
  name: string;
  width: number;
  height: number;
  background: string | null;
  layers: Layer[];
  /** Automatic intake is not undone when a user removes its layer. */
  sessionMediaAssetIds?: string[];
  updatedAt: string;
}

export interface DocumentSummary {
  id: string;
  revision: number;
  name: string;
  width: number;
  height: number;
  updatedAt: string;
}

export type Edit =
  | { type: 'insert'; layer: Layer; source?: 'session-media' }
  | { type: 'patch'; id: string; changes: LayerPatch }
  | { type: 'remove'; ids: string[] }
  | { type: 'reorder'; ids: string[] }
  | { type: 'canvas'; width?: number; height?: number; background?: string | null; name?: string };

export interface DocumentChange {
  documentId: string;
  expectedRevision: number;
  edits: Edit[];
}

export interface ExportRequest {
  documentId: string;
  expectedRevision: number;
  format: 'png' | 'jpeg' | 'webp';
  scale?: number;
  layerIds?: string[];
  background?: string;
}

export interface ExportResult {
  asset: Asset;
  renderedRevision: number;
  width: number;
  height: number;
}

export const anglePresets = ['front', 'back', 'god', 'side', 'three-quarter-left', 'three-quarter-right', 'low-angle', 'face-closeup', 'environment'] as const;
export type AnglePreset = typeof anglePresets[number];

export type GenerationAction = 'image' | 'edit' | 'remove-background' | 'upscale' | 'erase'
  | 'product-scene' | 'recolor' | 'model-display' | 'logo' | 'video' | 'storyboard'
  | 'white' | 'watermark' | 'resize' | 'translate' | 'edit-text' | 'angle' | 'erase-text';

export interface GenerationRequest {
  documentId: string;
  action: GenerationAction;
  prompt: string;
  sourceLayerIds?: string[];
  /** Ordered independent image assets appended after source layers; video/storyboard only. */
  referenceAssetIds?: string[];
  anglePreset?: AnglePreset;
  annotationAssetId?: string;
  markedAssetId?: string;
  expectedSourceAssetId?: string;
  expectedSourceCrop?: ImageLayer['crop'] | null;
  textEdits?: { marker: string; original: string; edited: string }[];
  logoAssetId?: string;
  selectionId?: string;
  size?: string;
  durationSeconds?: number;
  count?: number;
  scenes?: { prompt: string; durationSeconds?: number }[];
  colors?: { hex: string; opacity: number }[];
  modelAssetId?: string;
  material?: string;
  aspectRatio?: string;
  targetLanguage?: string;
}

export type GenerationEditing = Pick<GenerationRequest, 'selectionId' | 'size' | 'durationSeconds' | 'scenes' | 'referenceAssetIds'>;

export interface GenerationRecord {
  id: string;
  documentId: string;
  action: GenerationAction;
  prompt: string;
  state: 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  sourceLayerIds?: string[];
  editing?: GenerationEditing;
  placements?: { x: number; y: number; width: number; height: number }[];
  assets: Asset[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}
