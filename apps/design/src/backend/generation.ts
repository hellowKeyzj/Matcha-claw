import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isAppPixelSizeSupported, type AppModelRequest, type AppPluginContext, type AppToolContext } from '../../../../src/types/desktop/app-plugin-sdk';
import type { Asset, DesignDocument, GenerationAction, GenerationEditing, GenerationRecord, GenerationRequest, ImageLayer, VideoLayer } from '../document';
import type { Assets } from './assets';
import type { Documents } from './documents';
import { DesignError, errorMessage, writeAtomic } from './files';
import { generationPrompt } from './generation-instructions';
import { generateVideoScene } from './generation-video';
import { loadGenerationSnapshot, validateGenerationPlacements, type GenerationSnapshot } from './generation-snapshot';
import { prepareImageInput, imageInputKey } from './image-input';
import { targetSize } from './target-size';
import { generationRequest, id, invalid } from './validation';
import { composeStoryboard, requireFfmpeg } from './video';

const requiresImage = new Set<GenerationAction>(['edit', 'remove-background', 'upscale', 'erase', 'erase-text', 'angle', 'product-scene', 'recolor', 'model-display', 'logo', 'white', 'watermark', 'resize', 'translate', 'edit-text']);
type GenerationResult = { generation: GenerationRecord; document: DesignDocument };
type Placement = NonNullable<GenerationRecord['placements']>[number];

function fitPlacements(document: DesignDocument, sizes: { width: number; height: number }[], x: number, y: number, occupied: Placement[]): Placement[] {
  const result = sizes.map((size) => {
    const ratio = Math.max(0.01 / Math.min(size.width, size.height), Math.min(1, document.width / size.width, document.height / size.height));
    const width = size.width * ratio;
    const height = size.height * ratio;
    const maxX = 1000000 - width;
    const maxY = 1000000 - height;
    const preferredX = Math.max(-1000000, Math.min(maxX, x));
    const preferredY = Math.max(-1000000, Math.min(maxY, y));
    const rows = [preferredY, ...occupied.map((rect) => rect.y + rect.height + 24), ...occupied.map((rect) => rect.y - height - 24)];
    for (const row of rows) {
      if (row < -1000000 || row > maxY) continue;
      const blockers = occupied.filter((rect) => row < rect.y + rect.height + 24 && row + height + 24 > rect.y).sort((left, right) => left.x - right.x);
      let right = preferredX;
      for (const rect of blockers) {
        if (right < rect.x + rect.width + 24 && right + width + 24 > rect.x) right = rect.x + rect.width + 24;
      }
      let left = preferredX;
      if (right > maxX) for (const rect of [...blockers].reverse()) {
        if (left < rect.x + rect.width + 24 && left + width + 24 > rect.x) left = rect.x - width - 24;
      }
      const placedX = right <= maxX ? right : left;
      if (placedX < -1000000 || placedX > maxX) continue;
      const placement = { x: placedX, y: row, width, height };
      occupied.push(placement);
      x = placedX + width + 24;
      y = row;
      return placement;
    }
    throw new DesignError('canvas_full', 'No free position remains within the canvas coordinate limits. Move or remove layers before generating.');
  });
  validateGenerationPlacements(result);
  return result;
}

function validateSourceBinding(request: GenerationRequest, document: DesignDocument): void {
  if (request.expectedSourceAssetId === undefined && request.expectedSourceCrop === undefined) return;
  const source = document.layers.find((layer) => layer.id === request.sourceLayerIds?.[0]);
  if (!source || source.type !== 'image'
    || (request.expectedSourceAssetId !== undefined && source.assetId !== request.expectedSourceAssetId)
    || (request.expectedSourceCrop !== undefined && imageInputKey(source.assetId, source.crop) !== imageInputKey(source.assetId, request.expectedSourceCrop ?? undefined))) {
    throw new DesignError('source_changed', 'The source image or crop changed after this operation was prepared. Prepare the operation again before generating.');
  }
}

export function createGenerations(context: AppPluginContext, documents: Documents, assets: Assets) {
  const root = join(context.storagePath, 'generations');
  const active = new Map<string, { documentId: string; controller: AbortController; operation: Promise<GenerationResult>; committing: boolean; committed: boolean; placements?: Placement[] }>();
  const shutdown = new AbortController();
  let reservationPending = Promise.resolve();
  let recoveryPending = Promise.resolve();
  const recoveryQueue = new Map<string, GenerationSnapshot>();

  async function save(snapshot: GenerationSnapshot): Promise<void> {
    if (snapshot.record.placements !== undefined) validateGenerationPlacements(snapshot.record.placements);
    await writeAtomic(join(root, `${snapshot.record.id}.json`), snapshot);
    context.publish('generation.changed', { documentId: snapshot.record.documentId, generationId: snapshot.record.id });
  }

  async function initialize(): Promise<void> {
    await mkdir(root, { recursive: true });
    for (const entry of await readdir(root)) {
      if (!entry.endsWith('.json')) continue;
      const snapshot = await loadGenerationSnapshot(join(root, entry));
      if (snapshot.record.state !== 'completed' && snapshot.record.state !== 'cancelled'
        && (snapshot.videoTasks?.some((entry) => entry.status !== 'failed') || snapshot.outputAssetIds?.length)) {
        recoveryQueue.set(snapshot.record.id, snapshot);
      } else if (snapshot.record.state === 'running') {
        snapshot.record = { ...snapshot.record, state: 'interrupted', finishedAt: new Date().toISOString(),
          error: 'Plugin stopped before this generation finished. The provider may have charged or completed the request; it was not automatically retried.' };
        await save(snapshot);
      }
    }
    recoveryPending = (async () => {
      while (recoveryQueue.size) {
        if (shutdown.signal.aborted) return;
        while (active.size >= 4 && !shutdown.signal.aborted) await Promise.race([...active.values()].map((entry) => entry.operation.catch(() => {})));
        if (shutdown.signal.aborted) return;
        const snapshot = recoveryQueue.values().next().value as GenerationSnapshot | undefined;
        if (!snapshot) return;
        recoveryQueue.delete(snapshot.record.id);
        void start(snapshot.record.id, snapshot.record.documentId, (signal, beginCommit) => recover(snapshot, signal, beginCommit), snapshot.record.placements)
          .catch((error) => { context.log.error(`Design generation recovery ${snapshot.record.id}: ${errorMessage(error)}`); });
      }
    })();
  }

  async function list(documentId: string): Promise<GenerationRecord[]> {
    await documents.get(documentId);
    const result: GenerationRecord[] = [];
    for (const entry of await readdir(root)) {
      if (!entry.endsWith('.json')) continue;
      const snapshot = await loadGenerationSnapshot(join(root, entry));
      if (snapshot.record.documentId === documentId) result.push(snapshot.record);
    }
    return result.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async function prepare(request: GenerationRequest, document: DesignDocument, signal: AbortSignal) {
    signal.throwIfAborted();
    validateSourceBinding(request, document);
    const sourceLayerIds = request.sourceLayerIds ?? (requiresImage.has(request.action)
      ? document.layers.filter((layer) => layer.type === 'image' && layer.visible).map((layer) => layer.id) : []);
    const referenceAssetIds = request.referenceAssetIds ?? [];
    const extraImages = ['annotationAssetId', 'markedAssetId', 'logoAssetId', 'modelAssetId'] as const;
    if (sourceLayerIds.length + referenceAssetIds.length + extraImages.filter((field) => request[field]).length > 16) invalid('Use at most 16 source and reference images in total.');
    const images: { data: string; mimeType: string }[] = [];
    const inputAssets: Asset[] = [];
    const sourceInputs = new Map<string, { asset: Asset; image: { data: string; mimeType: string }; width?: number; height?: number }>();
    let firstSource: { width?: number; height?: number } | undefined;
    let sourceCrop: ImageLayer['crop'];
    for (const layerId of sourceLayerIds) {
      const layer = document.layers.find((layer) => layer.id === layerId);
      if (!layer || layer.type !== 'image') invalid(`Source layer ${layerId} is not an image layer in this document.`);
      const key = imageInputKey(layer.assetId, layer.crop);
      let input = sourceInputs.get(key);
      if (!input) {
        const source = await assets.read(layer.assetId);
        signal.throwIfAborted();
        if (!source.asset.mimeType.startsWith('image/')) invalid(`Source asset ${source.asset.id} is not an image.`);
        const cropped = await prepareImageInput(source, layer.crop, signal);
        input = { asset: source.asset, image: { data: cropped.bytes.toString('base64'), mimeType: cropped.mimeType }, width: cropped.width, height: cropped.height };
        sourceInputs.set(key, input);
      }
      if (!firstSource) { firstSource = input; sourceCrop = layer.crop; }
      images.push(input.image);
      inputAssets.push(input.asset);
    }
    if (requiresImage.has(request.action) && !images.length) invalid(`${request.action} requires a real source image layer. Import an image and select it first.`);
    for (const field of extraImages) {
      const assetId = request[field];
      if (!assetId) continue;
      const source = await assets.read(assetId);
      const { asset } = source;
      signal.throwIfAborted();
      if (!asset.mimeType.startsWith('image/')) invalid(`${field} must reference an image asset.`);
      const sourceSize = field === 'annotationAssetId' ? inputAssets[0] : firstSource;
      if ((field === 'annotationAssetId' || field === 'markedAssetId')
        && (asset.mimeType !== 'image/png' || asset.width !== sourceSize?.width || asset.height !== sourceSize?.height)) invalid(`${field} must reference a PNG with the same dimensions as its source image.`);
      const image = await prepareImageInput(source, field === 'annotationAssetId' ? sourceCrop : undefined, signal);
      images.push({ data: image.bytes.toString('base64'), mimeType: image.mimeType });
      inputAssets.push(asset);
    }
    for (const assetId of referenceAssetIds) {
      const source = await assets.read(assetId);
      signal.throwIfAborted();
      if (!source.asset.mimeType.startsWith('image/')) invalid(`Reference asset ${assetId} must be an image.`);
      const image = await prepareImageInput(source, undefined, signal);
      images.push({ data: image.bytes.toString('base64'), mimeType: image.mimeType });
      inputAssets.push(source.asset);
    }
    const size = targetSize(request, firstSource ?? inputAssets[0] ?? {});
    const editing: GenerationEditing = {
      ...(size ? { size: `${size.width}x${size.height}` } : request.size === undefined ? {} : { size: request.size }),
      ...(request.action === 'video' && request.durationSeconds !== undefined ? { durationSeconds: request.durationSeconds } : {}),
      ...(request.action === 'storyboard' ? { scenes: request.scenes } : {}),
      ...(request.referenceAssetIds === undefined ? {} : { referenceAssetIds }),
    };
    const source: Pick<AppModelRequest, 'images'> = images.length ? { images } : {};
    return { source, sourceLayerIds, inputAssetIds: inputAssets.map((asset) => asset.id), size, editing };
  }

  function reservations(documentId: string, generationId: string): Placement[] {
    return [...active.entries()].filter(([key, entry]) => key !== generationId && entry.documentId === documentId).flatMap(([, entry]) => entry.placements ?? [])
      .concat([...recoveryQueue.values()].filter((snapshot) => snapshot.record.id !== generationId && snapshot.record.documentId === documentId).flatMap((snapshot) => snapshot.record.placements ?? []));
  }

  function placements(Konva: typeof import('konva').default, document: DesignDocument, sourceLayerIds: string[], sizes: { width: number; height: number }[], reserved: Placement[], anchor?: Pick<Placement, 'x' | 'y'>): Placement[] {
    const bounds = document.layers.map((layer) => {
      const node = new Konva.Rect({ x: layer.x, y: layer.y, width: layer.width, height: layer.height, rotation: layer.rotation });
      const rect = node.getClientRect();
      node.destroy();
      return rect;
    });
    const sourceBounds = bounds.filter((_, index) => sourceLayerIds.includes(document.layers[index].id));
    const anchorBounds = sourceBounds.length ? sourceBounds : bounds;
    return fitPlacements(document, sizes, anchor?.x ?? (anchorBounds.length ? Math.max(...anchorBounds.map((rect) => rect.x + rect.width)) + 24 : 0),
      anchor?.y ?? (anchorBounds.length ? Math.min(...anchorBounds.map((rect) => rect.y)) : 0), [...bounds, ...reserved]);
  }

  async function validateModel(requests: AppModelRequest[], signal: AbortSignal): Promise<string> {
    const listed = await context.models.list({ kind: requests[0].kind }, signal);
    const selectionId = requests[0].selectionId ?? listed.defaultSelectionId;
    const selected = listed.models.find((model) => model.selectionId === selectionId);
    if (!selected) throw new DesignError('model_unavailable', 'Select a configured media model or configure a default media route before generating.');
    const capability = selected.capabilities;
    for (const request of requests) {
      if ((request.images?.length ?? 0) > capability.maxImages || (request.count ?? 1) > capability.maxCount) invalid('The selected model does not support this reference-image count or output count.');
      if (request.size && !(capability.sizes?.includes(request.size) || (capability.pixelSize && capability.pixelSizeLimits && isAppPixelSizeSupported(request.size, capability.pixelSizeLimits)))) {
        throw new DesignError('unsupported_target_size', 'The selected provider cannot execute the requested output size. No paid generation request was submitted.');
      }
      if (request.durationSeconds !== undefined && !capability.durationsSeconds?.includes(request.durationSeconds)) invalid('The selected video model does not support this duration.');
    }
    return selected.selectionId;
  }

  async function verifyImages(request: GenerationRequest, imported: Asset[], size: { width: number; height: number } | undefined, signal: AbortSignal): Promise<void> {
    const explicit = /^([1-9]\d*)x([1-9]\d*)$/.exec(request.size ?? '');
    const target = size ?? (explicit ? { width: Number(explicit[1]), height: Number(explicit[2]) } : undefined);
    if (target && imported.some((asset) => asset.width !== target.width || asset.height !== target.height)) {
      throw new DesignError('target_size_not_met', `The provider did not return the required ${target.width}x${target.height} pixels. All returned assets were saved; select a provider that supports exact pixel sizes. The request was not retried.`);
    }
    if (request.action !== 'remove-background') return;
    const { loadImage, Canvas } = await import('skia-canvas');
    for (const asset of imported) {
      signal.throwIfAborted();
      const image = await loadImage((await assets.read(asset.id)).bytes);
      const canvas = new Canvas(image.width, image.height);
      const drawing = canvas.getContext('2d');
      drawing.drawImage(image, 0, 0);
      const pixels = drawing.getImageData(0, 0, image.width, image.height).data;
      let hasTransparentPixels = false;
      for (let alpha = 3; alpha < pixels.length; alpha += 4) if (pixels[alpha] < 255) { hasTransparentPixels = true; break; }
      if (asset.mimeType !== 'image/png' || !hasTransparentPixels) throw new Error('Background removal did not return a transparent PNG. The output was saved, but background removal was not verified.');
    }
  }

  async function finish(snapshot: GenerationSnapshot, outputs: Asset[], signal: AbortSignal, beginCommit: () => void): Promise<GenerationResult> {
    signal.throwIfAborted();
    if (!snapshot.outputAssetIds) {
      snapshot.outputAssetIds = outputs.map((asset) => asset.id);
      snapshot.outputLayerIds = outputs.map(() => randomUUID());
      await save(snapshot);
    }
    const sizes = outputs.map((asset) => {
      if (!asset.width || !asset.height) throw new Error(`Output ${asset.id} has no measured dimensions. Assets were saved, but no layers were inserted.`);
      return { width: asset.width, height: asset.height };
    });
    const commit = reservationPending.then(async () => {
      signal.throwIfAborted();
      await import('konva/skia-backend');
      const { default: Konva } = await import('konva');
      const document = await documents.get(snapshot.record.documentId);
      const existing = document.layers.filter((layer) => snapshot.outputLayerIds!.includes(layer.id));
      if (existing.some((layer) => layer.type === 'text' || layer.assetId !== snapshot.outputAssetIds![snapshot.outputLayerIds!.indexOf(layer.id)])
        || (existing.length > 0 && existing.length !== outputs.length)) throw new Error('Generation layer receipt does not match the document. Saved assets were retained; layers were not duplicated.');
      let latest = document;
      if (existing.length !== outputs.length) {
        latest = await documents.insertLatest(document.id, (current) => {
          signal.throwIfAborted();
          const outputPlacements = placements(Konva, current, snapshot.record.sourceLayerIds ?? [], sizes,
            reservations(document.id, snapshot.record.id), snapshot.record.placements?.[0]);
          snapshot.record.placements = outputPlacements;
          active.get(snapshot.record.id)!.placements = outputPlacements;
          // Document commits cannot be undone by AbortSignal. Cancellation waits for this commit and the terminal record.
          beginCommit();
          return outputs.map((asset, index): ImageLayer | VideoLayer => ({ id: snapshot.outputLayerIds![index], type: asset.mimeType.startsWith('video/') ? 'video' : 'image',
            assetId: asset.id, name: asset.name, ...outputPlacements[index], rotation: 0, opacity: 1, visible: true, locked: false,
            ...(asset.mimeType.startsWith('image/') ? { lockAspectRatio: true } : {}) }));
        });
      } else {
        snapshot.record.placements = snapshot.outputLayerIds!.map((id) => {
          const { x, y, width, height } = existing.find((layer) => layer.id === id)!;
          return { x, y, width, height };
        });
        active.get(snapshot.record.id)!.placements = snapshot.record.placements;
        beginCommit();
      }
      active.get(snapshot.record.id)!.committed = true;
      const { error: _error, ...record } = snapshot.record;
      snapshot.record = { ...record, state: 'completed', finishedAt: new Date().toISOString() };
      await save(snapshot);
      return { generation: snapshot.record, document: latest };
    });
    reservationPending = commit.then(() => {}, () => {});
    return commit;
  }

  async function fail(snapshot: GenerationSnapshot, error: unknown, signal: AbortSignal, local: AbortSignal): Promise<never> {
    const entry = active.get(snapshot.record.id);
    if (entry?.committing && !entry.committed && snapshot.outputLayerIds?.length) {
      const current = await documents.get(snapshot.record.documentId);
      entry.committed = snapshot.outputLayerIds.every((layerId, index) => current.layers.some((layer) => layer.id === layerId && layer.type !== 'text' && layer.assetId === snapshot.outputAssetIds![index]));
    }
    if (entry?.committed) {
      snapshot.record = { ...snapshot.record, state: 'completed', finishedAt: snapshot.record.finishedAt ?? new Date().toISOString(),
        error: `Output layers were committed, but final record persistence or notification failed: ${errorMessage(error)}. Do not repeat the paid generation.` };
      try { await save(snapshot); } catch (persistenceError) {
        throw new DesignError('generation_commit_record_failed', `${snapshot.record.error} The output receipt will be reconciled on restart: ${errorMessage(persistenceError)}`,
          { generation: snapshot.record, document: await documents.get(snapshot.record.documentId) });
      }
      throw new DesignError('generation_committed', snapshot.record.error!, { generation: snapshot.record, document: await documents.get(snapshot.record.documentId) });
    }
    const state = shutdown.signal.aborted ? 'interrupted' : local.aborted ? 'cancelled' : signal.aborted || (error instanceof DesignError && error.code === 'interrupted') ? 'interrupted' : 'failed';
    snapshot.record = { ...snapshot.record, state, finishedAt: new Date().toISOString(),
      error: errorMessage(error) + (signal.aborted ? ' The provider may have charged or completed the request; local cancellation does not guarantee a remote stop or refund. It was not automatically retried.' : '') };
    try { await save(snapshot); } catch (persistenceError) {
      throw new Error(`${snapshot.record.error}; generation record could not be saved: ${errorMessage(persistenceError)}`, { cause: persistenceError });
    }
    throw new DesignError(state === 'failed' ? error instanceof DesignError ? error.code : 'generation_failed' : state, snapshot.record.error!,
      { generation: snapshot.record, document: await documents.get(snapshot.record.documentId) });
  }

  async function recover(snapshot: GenerationSnapshot, local: AbortSignal, beginCommit: () => void): Promise<GenerationResult> {
    const signal = AbortSignal.any([shutdown.signal, local]);
    try {
      const { request } = snapshot;
      await documents.get(request.documentId);
      const { finishedAt: _finishedAt, error: _error, ...record } = snapshot.record;
      snapshot.record = { ...record, state: 'running' };
      await save(snapshot);
      if (snapshot.outputAssetIds) return await finish(snapshot, await Promise.all(snapshot.outputAssetIds.map((assetId) => assets.get(assetId))), signal, beginCommit);
      const sceneCount = request.action === 'storyboard' ? request.scenes!.length : 1;
      const sceneVideos: Asset[] = [];
      for (const entry of [...snapshot.videoTasks!].sort((left, right) => left.sceneIndex - right.sceneIndex)) {
        const imported = await generateVideoScene(context, assets, snapshot, entry.sceneIndex, undefined, signal, save);
        sceneVideos.push(...(request.action === 'storyboard' ? [imported[0]] : imported));
      }
      if (snapshot.videoTasks!.length !== sceneCount) throw new DesignError('interrupted', 'Submitted video scenes were recovered, but remaining scenes were not automatically submitted. Existing outputs were saved; continuing would create new paid requests.');
      let outputs = sceneVideos;
      if (request.action === 'storyboard') {
        const ffmpeg = await requireFfmpeg(context.packagePath, signal);
        const bytes = await composeStoryboard(ffmpeg, context.storagePath, assets, sceneVideos, request.size, signal);
        const asset = await assets.importBytes('storyboard-local-concatenation.mp4', 'video/mp4', bytes, signal);
        snapshot.record.assets.push(asset);
        await save(snapshot);
        outputs = [asset];
      }
      return await finish(snapshot, outputs, signal, beginCommit);
    } catch (error) { return fail(snapshot, error, signal, local); }
  }

  async function run(request: GenerationRequest, tool: AppToolContext, generationId: string, local: AbortSignal, beginCommit: () => void): Promise<GenerationResult> {
    const signal = AbortSignal.any([tool.signal, shutdown.signal, local]);
    const document = await documents.get(request.documentId);
    const snapshot: GenerationSnapshot = { formatVersion: 1, request, sourceRevision: document.revision, inputAssetIds: [],
      record: { id: generationId, documentId: document.id, action: request.action, prompt: request.prompt, sourceLayerIds: request.sourceLayerIds ?? [],
        state: 'running', assets: [], startedAt: new Date().toISOString() } };
    try {
      await save(snapshot);
      const prepared = await prepare(request, document, signal);
      snapshot.inputAssetIds = prepared.inputAssetIds;
      snapshot.record.sourceLayerIds = prepared.sourceLayerIds;
      snapshot.record.editing = prepared.editing;
      const isVideo = request.action === 'video' || request.action === 'storyboard';
      const sourceLayer = document.layers.find((layer) => layer.id === prepared.sourceLayerIds[0]);
      const estimatedSize = prepared.size ?? (request.size && /^(\d+)x(\d+)$/.test(request.size)
        ? { width: Number(request.size.split('x')[0]), height: Number(request.size.split('x')[1]) }
        : { width: sourceLayer?.width ?? document.width, height: sourceLayer?.height ?? document.height });
      if (estimatedSize.width <= 0 || estimatedSize.height <= 0 || !Number.isFinite(estimatedSize.width * estimatedSize.height)) invalid('Invalid output size.');
      const reserve = reservationPending.then(async () => {
        signal.throwIfAborted();
        await import('konva/skia-backend');
        const { default: Konva } = await import('konva');
        const current = await documents.get(document.id);
        snapshot.record.placements = placements(Konva, current, prepared.sourceLayerIds, Array.from({ length: request.action === 'storyboard' ? 1 : request.count ?? 1 }, () => estimatedSize), reservations(document.id, generationId));
        active.get(generationId)!.placements = snapshot.record.placements;
        await save(snapshot);
      });
      reservationPending = reserve.catch(() => {});
      await reserve;
      const ffmpeg = request.action === 'storyboard' ? await requireFfmpeg(context.packagePath, signal) : undefined;
      const scenes = request.action === 'storyboard' ? request.scenes! : [{ prompt: request.prompt, durationSeconds: request.durationSeconds }];
      const sceneVideos: Asset[] = [];
      const modelRequests: AppModelRequest[] = scenes.map((scene) => ({
        kind: isVideo ? 'video' : 'image', prompt: generationPrompt(request, scene.prompt, prepared.size),
        ...prepared.source, ...(request.selectionId ? { selectionId: request.selectionId } : {}),
        ...(prepared.editing.size === undefined ? {} : { size: prepared.editing.size }),
        ...(scene.durationSeconds === undefined ? {} : { durationSeconds: scene.durationSeconds }),
        count: request.action === 'storyboard' ? 1 : request.count ?? 1,
      }));
      const selectionId = await validateModel(modelRequests, signal);
      snapshot.record.editing = { ...prepared.editing, selectionId };
      await save(snapshot);
      if (ffmpeg) tool.reportProgress(0, scenes.length, 'Generating independent scenes for local concatenation; native joint-storyboard generation is not supported.');
      for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex++) {
        signal.throwIfAborted();
        tool.reportProgress(sceneIndex, scenes.length, `Generating ${isVideo ? 'video' : 'image'}${scenes.length > 1 ? ` scene ${sceneIndex + 1}/${scenes.length}` : ''}`);
        const modelRequest = modelRequests[sceneIndex];
        if (request.expectedSourceAssetId !== undefined || request.expectedSourceCrop !== undefined) validateSourceBinding(request, await documents.get(request.documentId));
        signal.throwIfAborted();
        const imported: Asset[] = [];
        if (isVideo) imported.push(...await generateVideoScene(context, assets, snapshot, sceneIndex, { ...modelRequest, kind: 'video', selectionId }, signal, save));
        else {
          const result = await context.models.generate({ ...modelRequest, selectionId }, signal);
          if (!result.outputs.length || result.outputs.length > 8) throw new Error('The configured model returned an invalid number of media outputs.');
          for (let outputIndex = 0; outputIndex < result.outputs.length; outputIndex++) {
            signal.throwIfAborted();
            const output = result.outputs[outputIndex];
            const asset = await assets.importBase64(`${request.action}-${sceneIndex + 1}-${outputIndex + 1}`, output.mimeType, output.data, signal);
            snapshot.record.assets.push(asset);
            imported.push(asset);
            await save(snapshot);
          }
        }
        if (imported.some((asset) => !asset.mimeType.startsWith(isVideo ? 'video/' : 'image/'))) throw new Error(`The configured model returned unexpected media; expected ${isVideo ? 'video' : 'image'}. All returned assets have been saved.`);
        if (!isVideo) await verifyImages(request, imported, prepared.size, signal);
        if (isVideo) sceneVideos.push(imported[0]);
      }
      let outputs = snapshot.record.assets;
      if (ffmpeg) {
        signal.throwIfAborted();
        tool.reportProgress(scenes.length, scenes.length, 'Locally concatenating independent storyboard scenes');
        const bytes = await composeStoryboard(ffmpeg, context.storagePath, assets, sceneVideos, request.size, signal);
        const asset = await assets.importBytes('storyboard-local-concatenation.mp4', 'video/mp4', bytes, signal);
        snapshot.record.assets.push(asset);
        await save(snapshot);
        outputs = [asset];
      }
      const result = await finish(snapshot, outputs, signal, beginCommit);
      tool.reportProgress(scenes.length, scenes.length, ffmpeg ? 'Independent scenes concatenated locally; generation completed' : 'Generation completed');
      return result;
    } catch (error) { return fail(snapshot, error, signal, local); }
  }

  function start(generationId: string, documentId: string, execute: (signal: AbortSignal, beginCommit: () => void) => Promise<GenerationResult>, reserved?: Placement[]): Promise<GenerationResult> {
    shutdown.signal.throwIfAborted();
    if (active.size >= 4) throw new DesignError('busy', 'Four generations are already running. Wait before starting another paid request.');
    const controller = new AbortController();
    const operation = Promise.resolve().then(() => execute(controller.signal, () => { entry.committing = true; })).finally(() => { active.delete(generationId); });
    const entry = { documentId, controller, operation, committing: false, committed: false, placements: reserved };
    active.set(generationId, entry);
    return operation;
  }

  async function generate(request: GenerationRequest, tool: AppToolContext): Promise<GenerationResult> {
    const checked = generationRequest(request);
    const generationId = randomUUID();
    return start(generationId, checked.documentId, (signal, beginCommit) => run(checked, tool, generationId, signal, beginCommit));
  }

  async function cancel(documentId: string, generationId: string): Promise<{ generation: GenerationRecord }> {
    id(documentId, 'documentId'); id(generationId, 'generationId');
    const queued = recoveryQueue.get(generationId);
    if (queued) {
      if (queued.record.documentId !== documentId) throw new DesignError('generation_not_found', 'This generation does not belong to the requested document.');
      recoveryQueue.delete(generationId);
      queued.record = { ...queued.record, state: 'cancelled', finishedAt: new Date().toISOString(),
        error: 'Video recovery was cancelled locally. Saved assets were retained; remote completion, charges or refunds were not changed.' };
      await save(queued);
      return { generation: queued.record };
    }
    const entry = active.get(generationId);
    if (entry && entry.documentId !== documentId) throw new DesignError('generation_not_found', 'This generation does not belong to the requested document.');
    if (entry) {
      if (!entry.committing) entry.controller.abort(new Error('Generation was cancelled locally.'));
      await entry.operation.catch(() => {});
    }
    let snapshot: GenerationSnapshot;
    try { snapshot = await loadGenerationSnapshot(join(root, `${generationId}.json`)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DesignError('generation_not_found', 'The generation record does not exist.');
      throw error;
    }
    if (snapshot.record.documentId !== documentId) throw new DesignError('generation_not_found', 'This generation does not belong to the requested document.');
    if (snapshot.record.state === 'running') throw new DesignError('generation_not_settled', 'The generation terminal state could not be saved. Do not retry the paid request automatically.');
    return { generation: snapshot.record };
  }

  async function close(): Promise<void> {
    shutdown.abort(new Error('Design plugin was deactivated.'));
    try {
      await recoveryPending;
      for (const snapshot of recoveryQueue.values()) {
        snapshot.record = { ...snapshot.record, state: 'interrupted', finishedAt: new Date().toISOString(),
          error: 'The plugin stopped before video recovery could run. Existing task receipts were retained; no paid request was submitted again.' };
        await save(snapshot);
      }
      recoveryQueue.clear();
    } finally { await Promise.allSettled([...active.values()].map((entry) => entry.operation)); }
  }
  return { initialize, list, generate, cancel, close };
}
