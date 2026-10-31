import { anglePresets, type DocumentChange, type Edit, type ExportRequest, type GenerationAction, type GenerationRequest, type Layer, type LayerPatch } from '../document';
import { DesignError } from './files';
import { aspectRatios } from './target-size';

export function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object.');
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).find((key) => !fields.includes(key));
  if (unknown !== undefined) invalid(`Unknown field: ${unknown}`);
  return result;
}

export function invalid(message: string): never { throw new DesignError('invalid_input', message); }

export function text(value: unknown, field: string, maximum = 1000, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maximum) invalid(`Invalid ${field}.`);
  return value;
}

export function number(value: unknown, field: string, minimum: number, maximum: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum
    || (integer && !Number.isSafeInteger(value))) invalid(`Invalid ${field}; expected ${minimum}–${maximum}${integer ? ' integer' : ''}.`);
  return value;
}

export function id(value: unknown, field = 'id'): string {
  const result = text(value, field, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) invalid(`Invalid ${field}.`);
  return result;
}

export function revision(value: unknown): number { return number(value, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER, true); }

export function dimensions(width: number, height: number): void {
  number(width, 'width', 1, 32768);
  number(height, 'height', 1, 32768);
  if (width * height > 64 * 1024 * 1024) invalid('Canvas exceeds 64 megapixels.');
}

export function ids(value: unknown, field: string, maximum = 2048): string[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`Invalid ${field}.`);
  const result = value.map((entry) => id(entry, field));
  if (new Set(result).size !== result.length) invalid(`${field} contains duplicate IDs.`);
  return result;
}

const common = ['id', 'type', 'name', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'locked'];
const media = ['assetId'];
const image = ['crop', 'flipX', 'flipY', 'lockAspectRatio', 'adjustments', 'stroke', 'shadow'];
const typography = ['text', 'fontFamily', 'fontSize', 'fontStyle', 'fill', 'align', 'lineHeight'];

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(`Invalid ${field}.`);
  return value;
}

function properties(value: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'id' || key === 'type') continue;
    switch (key) {
      case 'x': case 'y': result[key] = number(entry, key, -1000000, 1000000); break;
      case 'width': case 'height': result[key] = number(entry, key, 0.01, 32768); break;
      case 'rotation': result[key] = number(entry, key, -360000, 360000); break;
      case 'opacity': result[key] = number(entry, key, 0, 1); break;
      case 'visible': case 'locked': case 'flipX': case 'flipY': case 'lockAspectRatio':
        result[key] = boolean(entry, key); break;
      case 'crop': {
        const crop = object(entry, ['x', 'y', 'width', 'height']);
        result[key] = { x: number(crop.x, 'crop.x', 0, 32768), y: number(crop.y, 'crop.y', 0, 32768),
          width: number(crop.width, 'crop.width', Number.MIN_VALUE, 32768), height: number(crop.height, 'crop.height', Number.MIN_VALUE, 32768) };
        break;
      }
      case 'adjustments': {
        const adjustments = object(entry, ['blur', 'brightness', 'contrast', 'hue', 'saturation', 'invert']);
        result[key] = { blur: number(adjustments.blur, 'adjustments.blur', 0, 100),
          brightness: number(adjustments.brightness, 'adjustments.brightness', -100, 100), contrast: number(adjustments.contrast, 'adjustments.contrast', -100, 100),
          hue: number(adjustments.hue, 'adjustments.hue', -100, 100), saturation: number(adjustments.saturation, 'adjustments.saturation', -100, 100),
          invert: boolean(adjustments.invert, 'adjustments.invert') };
        break;
      }
      case 'stroke': {
        const stroke = object(entry, ['color', 'width', 'opacity']);
        result[key] = { color: text(stroke.color, 'stroke.color', 500), width: number(stroke.width, 'stroke.width', 0, 32768), opacity: number(stroke.opacity, 'stroke.opacity', 0, 1) };
        break;
      }
      case 'shadow': {
        const shadow = object(entry, ['color', 'blur', 'offsetX', 'offsetY', 'opacity']);
        result[key] = { color: text(shadow.color, 'shadow.color', 500), blur: number(shadow.blur, 'shadow.blur', 0, 32768),
          offsetX: number(shadow.offsetX, 'shadow.offsetX', -1000000, 1000000), offsetY: number(shadow.offsetY, 'shadow.offsetY', -1000000, 1000000),
          opacity: number(shadow.opacity, 'shadow.opacity', 0, 1) };
        break;
      }
      case 'assetId': result[key] = id(entry, key); break;
      case 'fontSize': result[key] = number(entry, key, 0.1, 4096); break;
      case 'lineHeight': result[key] = number(entry, key, 0.1, 20); break;
      case 'fontStyle':
        if (!['normal', 'bold', 'italic', 'bold italic'].includes(String(entry))) invalid('Invalid fontStyle.');
        result[key] = entry; break;
      case 'align':
        if (!['left', 'center', 'right'].includes(String(entry))) invalid('Invalid align.');
        result[key] = entry; break;
      case 'text': result[key] = text(entry, key, 100000, true); break;
      default: result[key] = text(entry, key, key === 'name' ? 200 : 500, partial && key === 'name');
    }
  }
  return result;
}

export function layer(value: unknown): Layer {
  const raw = object(value, [...common, ...media, ...image, ...typography]);
  const type = raw.type;
  if (type !== 'image' && type !== 'video' && type !== 'text') invalid('Layer type must be image, video or text.');
  const required = [...common, ...(type === 'text' ? typography : media)];
  object(raw, [...required, ...(type === 'image' ? image : [])]);
  for (const field of required) if (!(field in raw)) invalid(`Missing layer ${field}.`);
  return { id: id(raw.id), type, ...properties(raw, false) } as Layer;
}

export function layerPatch(value: unknown, type?: Layer['type']): LayerPatch {
  const fields = [...common.filter((key) => key !== 'id' && key !== 'type'),
    ...(type === 'text' ? typography : type === 'video' ? media : type === 'image' ? [...media, ...image] : [...media, ...image, ...typography])];
  return properties(object(value, fields), true) as LayerPatch;
}

function edit(value: unknown): Edit {
  const raw = object(value, ['type', 'layer', 'source', 'id', 'changes', 'ids', 'width', 'height', 'background', 'name']);
  switch (raw.type) {
    case 'insert': {
      object(raw, ['type', 'layer', 'source']);
      const inserted = layer(raw.layer);
      if (raw.source !== undefined && (raw.source !== 'session-media' || inserted.type === 'text')) invalid('session-media intake requires an image or video layer.');
      return { type: 'insert', layer: inserted, ...(raw.source === undefined ? {} : { source: 'session-media' }) };
    }
    case 'patch': object(raw, ['type', 'id', 'changes']); return { type: 'patch', id: id(raw.id), changes: layerPatch(raw.changes) };
    case 'remove': case 'reorder': object(raw, ['type', 'ids']); return { type: raw.type, ids: ids(raw.ids, 'ids') };
    case 'canvas': {
      object(raw, ['type', 'width', 'height', 'background', 'name']);
      return { type: 'canvas',
        ...(raw.width === undefined ? {} : { width: number(raw.width, 'width', 1, 32768) }),
        ...(raw.height === undefined ? {} : { height: number(raw.height, 'height', 1, 32768) }),
        ...(raw.background === undefined ? {} : { background: raw.background === null ? null : text(raw.background, 'background', 500) }),
        ...(raw.name === undefined ? {} : { name: text(raw.name, 'name', 200) }) };
    }
    default: return invalid('Unknown edit type.');
  }
}

export function change(value: unknown): DocumentChange {
  const raw = object(value, ['documentId', 'expectedRevision', 'edits']);
  if (!Array.isArray(raw.edits) || raw.edits.length < 1 || raw.edits.length > 1024) invalid('Provide 1–1024 edits.');
  return { documentId: id(raw.documentId, 'documentId'), expectedRevision: revision(raw.expectedRevision), edits: raw.edits.map(edit) };
}

export function exportRequest(value: unknown): ExportRequest {
  const raw = object(value, ['documentId', 'expectedRevision', 'format', 'scale', 'layerIds', 'background']);
  if (!['png', 'jpeg', 'webp'].includes(String(raw.format))) invalid('Export format must be png, jpeg or webp.');
  return { documentId: id(raw.documentId, 'documentId'), expectedRevision: revision(raw.expectedRevision), format: raw.format as ExportRequest['format'],
    ...(raw.scale === undefined ? {} : { scale: number(raw.scale, 'scale', 0.01, 8) }),
    ...(raw.layerIds === undefined ? {} : { layerIds: ids(raw.layerIds, 'layerIds') }),
    ...(raw.background === undefined ? {} : { background: text(raw.background, 'background', 500) }) };
}

export const generationActions: GenerationAction[] = ['image', 'edit', 'remove-background', 'upscale', 'erase', 'product-scene', 'recolor', 'model-display', 'logo', 'video', 'storyboard', 'white', 'watermark', 'resize', 'translate', 'edit-text', 'angle', 'erase-text'];
const singleSourceActions = new Set<GenerationAction>(['remove-background', 'upscale', 'erase', 'white', 'watermark', 'resize', 'translate', 'edit-text', 'angle', 'erase-text']);

// Stored v1 requests predate single-source shortcuts and structured recolor inputs.
export function generationRequest(value: unknown, historical = false): GenerationRequest {
  const raw = object(value, ['documentId', 'action', 'prompt', 'sourceLayerIds', 'referenceAssetIds', 'anglePreset', 'annotationAssetId', 'logoAssetId', 'modelAssetId', 'selectionId', 'size', 'durationSeconds', 'count', 'scenes', 'colors', 'aspectRatio', 'targetLanguage', 'markedAssetId', 'expectedSourceAssetId', 'expectedSourceCrop', 'textEdits', 'material']);
  if (!generationActions.includes(raw.action as GenerationAction)) invalid('Unknown generation action.');
  const action = raw.action as GenerationAction;
  const sourceLimit = action === 'logo' || raw.modelAssetId !== undefined ? 15 : 16;
  const sourceLayerIds = raw.sourceLayerIds === undefined ? undefined : ids(raw.sourceLayerIds, 'sourceLayerIds', sourceLimit);
  if (raw.referenceAssetIds !== undefined && action !== 'video' && action !== 'storyboard') invalid('referenceAssetIds is only valid for video or storyboard.');
  const referenceAssetIds = raw.referenceAssetIds === undefined ? undefined : ids(raw.referenceAssetIds, 'referenceAssetIds', 16);
  if ((sourceLayerIds?.length ?? 0) + (referenceAssetIds?.length ?? 0) > 16) invalid('Use at most 16 source layers and independent reference assets in total.');
  if (action === 'angle') {
    if (!anglePresets.includes(raw.anglePreset as typeof anglePresets[number])) invalid('angle requires a supported anglePreset.');
  } else if (raw.anglePreset !== undefined) invalid('anglePreset is only valid for angle.');
  if ((!historical || action === 'angle' || action === 'erase-text') && singleSourceActions.has(action) && sourceLayerIds?.length !== 1) invalid(`${action} requires exactly one explicitly specified source image layer; submit separate requests for multiple images.`);
  if (raw.annotationAssetId !== undefined) {
    if (action !== 'edit' && action !== 'erase') invalid('annotationAssetId is only valid for edit or erase.');
    if (sourceLayerIds?.length !== 1) invalid('annotationAssetId requires exactly one explicitly specified source image layer.');
  }
  if (action === 'logo') {
    id(raw.logoAssetId, 'logoAssetId');
    if (!sourceLayerIds?.length) invalid('Product logo placement requires source image layers.');
  } else if (raw.logoAssetId !== undefined) invalid('logoAssetId is only valid for product logo placement.');
  if (raw.material !== undefined && action !== 'logo') invalid('material is only valid for logo.');
  if (raw.modelAssetId !== undefined && action !== 'model-display') invalid('modelAssetId is only valid for model-display.');
  if (raw.colors !== undefined && action !== 'recolor') invalid('colors is only valid for recolor.');
  let colors: GenerationRequest['colors'];
  if (raw.colors !== undefined || (action === 'recolor' && !historical)) {
    if (!Array.isArray(raw.colors) || raw.colors.length < 1 || raw.colors.length > 8) invalid('Recolor requires 1–8 colors.');
    colors = raw.colors.map((value) => {
      const color = object(value, ['hex', 'opacity']);
      if (typeof color.hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color.hex)) invalid('Color hex must be #RRGGBB.');
      return { hex: color.hex, opacity: number(color.opacity, 'color opacity', 0, 100, true) };
    });
  }
  if (raw.aspectRatio !== undefined && action !== 'resize') invalid('aspectRatio is only valid for resize.');
  if (action === 'resize' && !aspectRatios.includes(raw.aspectRatio as typeof aspectRatios[number])) invalid('Resize requires a supported aspectRatio.');
  if (raw.targetLanguage !== undefined && action !== 'translate') invalid('targetLanguage is only valid for translate.');
  if (action === 'translate') text(raw.targetLanguage, 'targetLanguage', 100);
  if (!historical && (action === 'resize' || action === 'upscale') && raw.size !== undefined) invalid('resize and upscale compute their target size from the source image; do not supply size.');
  let textEdits: GenerationRequest['textEdits'];
  const boundSource = action === 'edit-text' || raw.annotationAssetId !== undefined;
  if (!boundSource && (raw.expectedSourceAssetId !== undefined || raw.expectedSourceCrop !== undefined)) invalid('Source binding is only valid for edit-text or annotated edit/erase.');
  let expectedSourceCrop: GenerationRequest['expectedSourceCrop'];
  if (boundSource) {
    if (!historical || raw.expectedSourceAssetId !== undefined) id(raw.expectedSourceAssetId, 'expectedSourceAssetId');
    if (!historical && raw.expectedSourceCrop === undefined) invalid('Marked image operations require the exact expectedSourceCrop, or null for an uncropped source.');
    if (raw.expectedSourceCrop !== undefined) {
      expectedSourceCrop = raw.expectedSourceCrop === null ? null : properties({ crop: raw.expectedSourceCrop }, true).crop as NonNullable<GenerationRequest['expectedSourceCrop']>;
    }
  }
  if (action === 'edit-text') {
    id(raw.markedAssetId, 'markedAssetId');
    if (raw.annotationAssetId !== undefined || raw.logoAssetId !== undefined || raw.modelAssetId !== undefined) invalid('edit-text cannot combine markedAssetId with annotation, Logo or model references.');
    if (!Array.isArray(raw.textEdits) || raw.textEdits.length < 1 || raw.textEdits.length > 200) invalid('edit-text requires 1–200 text edits.');
    textEdits = raw.textEdits.map((value) => {
      const edit = object(value, ['marker', 'original', 'edited']);
      return { marker: text(edit.marker, 'text marker', 100), original: text(edit.original, 'original text', 2000), edited: text(edit.edited, 'edited text', 2000, true) };
    });
    if (new Set(textEdits.map((edit) => edit.marker.trim())).size !== textEdits.length) invalid('textEdits contains duplicate markers.');
  } else if (raw.markedAssetId !== undefined || raw.textEdits !== undefined) invalid('markedAssetId and textEdits are only valid for edit-text.');
  let scenes: GenerationRequest['scenes'];
  if (raw.scenes !== undefined) {
    if (!Array.isArray(raw.scenes) || !raw.scenes.length || raw.scenes.length > 24) invalid('Provide 1–24 storyboard scenes.');
    scenes = raw.scenes.map((value) => {
      const scene = object(value, ['prompt', 'durationSeconds']);
      return { prompt: text(scene.prompt, 'scene prompt', 20000),
        ...(scene.durationSeconds === undefined ? {} : { durationSeconds: number(scene.durationSeconds, 'scene durationSeconds', 1, 120) }) };
    });
  }
  if (action === 'storyboard' && !scenes) invalid('Storyboard requires scenes.');
  if (action !== 'storyboard' && scenes) invalid('scenes is only valid for storyboard.');
  if (action === 'storyboard' && raw.count !== undefined && raw.count !== 1) invalid('Storyboard count must be 1; every returned scene output is still saved.');
  const prompt = text(raw.prompt, 'prompt', 20000, true);
  if (!prompt.trim() && !['remove-background', 'upscale', 'erase', 'storyboard', 'white', 'watermark', 'resize', 'translate', 'edit-text', 'angle', 'erase-text'].includes(action)) invalid('This action requires a prompt.');
  return { documentId: id(raw.documentId, 'documentId'), action, prompt,
    ...(sourceLayerIds === undefined ? {} : { sourceLayerIds }),
    ...(referenceAssetIds === undefined ? {} : { referenceAssetIds }),
    ...(action === 'angle' ? { anglePreset: raw.anglePreset as GenerationRequest['anglePreset'] } : {}),
    ...(raw.annotationAssetId === undefined ? {} : { annotationAssetId: id(raw.annotationAssetId, 'annotationAssetId') }),
    ...(raw.logoAssetId === undefined ? {} : { logoAssetId: id(raw.logoAssetId, 'logoAssetId') }),
    ...(raw.modelAssetId === undefined ? {} : { modelAssetId: id(raw.modelAssetId, 'modelAssetId') }),
    ...(raw.material === undefined ? {} : { material: text(raw.material, 'material', 2000) }),
    ...(raw.markedAssetId === undefined ? {} : { markedAssetId: id(raw.markedAssetId, 'markedAssetId') }),
    ...(raw.expectedSourceAssetId === undefined ? {} : { expectedSourceAssetId: id(raw.expectedSourceAssetId, 'expectedSourceAssetId') }),
    ...(expectedSourceCrop === undefined ? {} : { expectedSourceCrop }),
    ...(textEdits === undefined ? {} : { textEdits }), ...(colors === undefined ? {} : { colors }),
    ...(raw.aspectRatio === undefined ? {} : { aspectRatio: raw.aspectRatio as string }),
    ...(raw.targetLanguage === undefined ? {} : { targetLanguage: text(raw.targetLanguage, 'targetLanguage', 100) }),
    ...(raw.selectionId === undefined ? {} : { selectionId: text(raw.selectionId, 'selectionId', 500) }),
    ...(raw.size === undefined ? {} : { size: text(raw.size, 'size', 100) }),
    ...(raw.durationSeconds === undefined ? {} : { durationSeconds: number(raw.durationSeconds, 'durationSeconds', 1, 120) }),
    ...(raw.count === undefined ? {} : { count: number(raw.count, 'count', 1, 8, true) }),
    ...(scenes ? { scenes } : {}) };
}
