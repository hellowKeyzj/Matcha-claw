import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSessionIdentityKey, validateSessionIdentity, type SessionIdentity } from '../../../../src/types/desktop/runtime-address';
import type { Asset, DesignDocument, DocumentChange, DocumentSummary, Edit, ImageLayer, Layer, VideoLayer } from '../document';
import type { Assets } from './assets';
import { DesignError, readJson, requireRevision, writeAtomic } from './files';
import { dimensions, id, ids, invalid, layer, layerPatch, number, object, text } from './validation';

type DocumentState = Omit<DesignDocument, 'sessionMediaAssetIds'>;

interface DocumentSnapshot {
  formatVersion: 1;
  document: DesignDocument;
  history: { undo: DocumentState[]; redo: DocumentState[] };
}

function historyState({ sessionMediaAssetIds: _sessionMediaAssetIds, ...state }: DesignDocument): DocumentState {
  return state;
}

export function parseSessionIdentity(value: unknown): SessionIdentity | undefined {
  if (value === undefined) return undefined;
  const error = validateSessionIdentity(value);
  if (error) invalid(error);
  return value as SessionIdentity;
}

function parseDocument(value: unknown): DesignDocument {
  const raw = object(value, ['schemaVersion', 'id', 'sessionIdentity', 'revision', 'name', 'width', 'height', 'background', 'layers', 'sessionMediaAssetIds', 'updatedAt']);
  parseSessionIdentity(raw.sessionIdentity);
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.layers) || raw.layers.length > 2048) throw new Error('Invalid document snapshot.');
  id(raw.id); number(raw.revision, 'revision', 0, Number.MAX_SAFE_INTEGER, true);
  text(raw.name, 'name', 200); dimensions(raw.width as number, raw.height as number);
  if (raw.background !== null) text(raw.background, 'background', 500);
  if (typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) throw new Error('Invalid document timestamp.');
  const layers = raw.layers.map(layer);
  if (new Set(layers.map((entry) => entry.id)).size !== layers.length) throw new Error('Duplicate layer IDs in document snapshot.');
  if (raw.sessionMediaAssetIds !== undefined) ids(raw.sessionMediaAssetIds, 'sessionMediaAssetIds', Number.MAX_SAFE_INTEGER);
  return { ...raw, layers } as unknown as DesignDocument;
}

export function createDocuments(storagePath: string, assets: Assets, changed: (document: DesignDocument) => void) {
  const root = join(storagePath, 'documents');
  const pending = new Map<string, Promise<unknown>>();
  let queued = 0;

  async function serial<T>(documentId: string, operation: () => Promise<T>): Promise<T> {
    id(documentId, 'documentId');
    if (queued >= 128) throw new DesignError('busy', 'Too many pending document operations; wait for the current edits to finish.');
    queued++;
    const previous = pending.get(documentId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    pending.set(documentId, next);
    try { return await next; } finally {
      queued--;
      if (pending.get(documentId) === next) pending.delete(documentId);
    }
  }

  async function load(documentId: string): Promise<DocumentSnapshot> {
    let value: unknown;
    try { value = await readJson(join(root, `${documentId}.json`)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DesignError('not_found', `Document ${documentId} does not exist.`);
      throw error;
    }
    const raw = object(value, ['formatVersion', 'document', 'history']);
    const history = object(raw.history, ['undo', 'redo']);
    if (raw.formatVersion !== 1 || !Array.isArray(history.undo) || !Array.isArray(history.redo)) throw new Error('Invalid document history format.');
    const document = parseDocument(raw.document);
    const undo = history.undo.map(parseDocument);
    const redo = history.redo.map(parseDocument);
    if (document.id !== documentId || [...undo, ...redo].some((entry) => entry.id !== documentId)) throw new Error('Document history identity mismatch.');
    return { formatVersion: 1, document, history: { undo, redo } };
  }

  async function save(snapshot: DocumentSnapshot): Promise<DesignDocument> {
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 64 * 1024 * 1024) throw new DesignError('history_full', 'Document history exceeds 64 MiB; create a new document before continuing. No edits were committed.');
    await writeAtomic(join(root, `${snapshot.document.id}.json`), snapshot);
    changed(snapshot.document);
    return snapshot.document;
  }

  async function validateAssets(layers: Layer[]): Promise<void> {
    const checked = new Map<string, Asset>();
    for (const entry of layers) {
      if (entry.type === 'text') continue;
      const asset = checked.get(entry.assetId) ?? await assets.get(entry.assetId);
      if (!asset.mimeType.startsWith(`${entry.type}/`)) invalid(`Layer asset ${entry.assetId} is not ${entry.type}.`);
      if (entry.type === 'image' && entry.crop) {
        const { x, y, width, height } = entry.crop;
        if (asset.width === undefined || asset.height === undefined
          || x < 0 || y < 0 || width <= 0 || height <= 0
          || x + width > asset.width || y + height > asset.height) invalid(`Layer crop exceeds image asset ${entry.assetId} bounds.`);
      }
      checked.set(entry.assetId, asset);
    }
  }

  function apply(document: DesignDocument, edits: readonly Edit[]): { document: DesignDocument; undoable: boolean } {
    const result = structuredClone(document);
    let consumed = false;
    let undoable = false;
    for (const edit of edits) {
      if (edit.type === 'canvas') {
        if (edit.width !== undefined) result.width = edit.width;
        if (edit.height !== undefined) result.height = edit.height;
        if (edit.background !== undefined) result.background = edit.background;
        if (edit.name !== undefined) result.name = edit.name;
      } else if (edit.type === 'insert') {
        const inserted = layer(edit.layer);
        if (edit.source === 'session-media') {
          if (inserted.type === 'text') invalid('session-media intake requires an image or video layer.');
          if (result.sessionMediaAssetIds?.includes(inserted.assetId)) continue;
          (result.sessionMediaAssetIds ??= []).push(inserted.assetId);
          consumed = true;
          if (result.layers.some((entry) => entry.type !== 'text' && entry.assetId === inserted.assetId)) continue;
        }
        if (result.layers.some((entry) => entry.id === inserted.id)) invalid(`Layer ${inserted.id} already exists.`);
        result.layers.push(inserted);
      } else if (edit.type === 'patch') {
        const index = result.layers.findIndex((entry) => entry.id === edit.id);
        if (index < 0) throw new DesignError('not_found', `Layer ${edit.id} does not exist.`);
        result.layers[index] = { ...result.layers[index], ...layerPatch(edit.changes, result.layers[index].type) } as Layer;
      } else {
        const byId = new Map(result.layers.map((entry) => [entry.id, entry]));
        for (const layerId of edit.ids) if (!byId.has(layerId)) throw new DesignError('not_found', `Layer ${layerId} does not exist.`);
        if (edit.type === 'remove') result.layers = result.layers.filter((entry) => !edit.ids.includes(entry.id));
        else {
          if (edit.ids.length !== result.layers.length) invalid('reorder.ids must contain every layer exactly once.');
          result.layers = edit.ids.map((layerId) => byId.get(layerId)!);
        }
      }
      undoable = true;
    }
    if (!undoable && !consumed) return { document, undoable };
    dimensions(result.width, result.height);
    if (result.layers.length > 2048) invalid('Document exceeds 2048 layers.');
    result.revision = document.revision + 1;
    result.updatedAt = new Date().toISOString();
    return { document: parseDocument(result), undoable };
  }

  async function commitEdits(snapshot: DocumentSnapshot, edits: readonly Edit[]): Promise<DesignDocument> {
    const { document, undoable } = apply(snapshot.document, edits);
    if (document === snapshot.document) return document;
    await validateAssets(document.layers);
    return save({ formatVersion: 1, document, history: undoable
      ? { undo: [...snapshot.history.undo, historyState(snapshot.document)], redo: [] }
      : snapshot.history });
  }

  async function create(name = 'Untitled', width = 1024, height = 1024, sessionIdentity?: SessionIdentity): Promise<DesignDocument> {
    text(name, 'name', 200); dimensions(width, height);
    const key = sessionIdentity && buildSessionIdentityKey(sessionIdentity);
    const documentId = key ? createHash('sha256').update(key).digest('hex') : randomUUID();
    return serial(documentId, async () => {
      if (key) {
        try {
          const { document } = await load(documentId);
          if (!document.sessionIdentity || buildSessionIdentityKey(document.sessionIdentity) !== key) throw new Error('Document session identity mismatch.');
          return document;
        } catch (error) {
          if (!(error instanceof DesignError) || error.code !== 'not_found') throw error;
        }
      }
      const document: DesignDocument = { schemaVersion: 1, id: documentId, revision: 0, name,
        ...(sessionIdentity ? { sessionIdentity: structuredClone(sessionIdentity) } : {}),
        width, height, background: null, layers: [], updatedAt: new Date().toISOString() };
      return save({ formatVersion: 1, document, history: { undo: [], redo: [] } });
    });
  }

  async function get(documentId: string): Promise<DesignDocument> { return serial(documentId, async () => (await load(documentId)).document); }

  async function list(sessionIdentity?: SessionIdentity): Promise<DocumentSummary[]> {
    const key = sessionIdentity && buildSessionIdentityKey(sessionIdentity);
    await mkdir(root, { recursive: true });
    const result: DocumentSummary[] = [];
    for (const entry of await readdir(root)) {
      if (!entry.endsWith('.json')) continue;
      const document = await get(entry.slice(0, -5));
      if (key && (!document.sessionIdentity || buildSessionIdentityKey(document.sessionIdentity) !== key)) continue;
      const { id, revision, name, width, height, updatedAt } = document;
      result.push({ id, revision, name, width, height, updatedAt });
    }
    return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function edit(change: DocumentChange): Promise<DesignDocument> {
    return serial(change.documentId, async () => {
      const snapshot = await load(change.documentId);
      requireRevision(snapshot.document.revision, change.expectedRevision);
      return commitEdits(snapshot, change.edits);
    });
  }

  async function insertLatest(documentId: string, layers: Layer[] | ((document: DesignDocument) => Layer[])): Promise<DesignDocument> {
    return serial(documentId, async () => {
      const snapshot = await load(documentId);
      const inserted = typeof layers === 'function' ? layers(snapshot.document) : layers;
      return commitEdits(snapshot, inserted.map((layer) => ({ type: 'insert', layer })));
    });
  }

  async function openAsset(
    documentId: string, source: ImageLayer | VideoLayer | ((document: DesignDocument) => ImageLayer | VideoLayer),
  ): Promise<{ document: DesignDocument; layerId: string; reused: boolean }> {
    return serial(documentId, async () => {
      const snapshot = await load(documentId);
      const entry = layer(typeof source === 'function' ? source(snapshot.document) : source);
      if (entry.type === 'text') invalid('openAsset requires an image or video layer.');
      const existing = snapshot.document.layers.find((candidate) => candidate.type !== 'text' && candidate.type === entry.type && candidate.assetId === entry.assetId);
      if (existing) {
        await validateAssets([entry]);
        const document = existing.visible ? snapshot.document
          : await commitEdits(snapshot, [{ type: 'patch', id: existing.id, changes: { visible: true } }]);
        return { document, layerId: existing.id, reused: true };
      }
      const document = await commitEdits(snapshot, [{ type: 'insert', layer: entry }]);
      return { document, layerId: entry.id, reused: false };
    });
  }

  async function travel(documentId: string, expectedRevision: number, direction: 'undo' | 'redo'): Promise<DesignDocument> {
    return serial(documentId, async () => {
      const snapshot = await load(documentId);
      requireRevision(snapshot.document.revision, expectedRevision);
      const source = snapshot.history[direction];
      if (!source.length) throw new DesignError('history_empty', `There is nothing to ${direction}.`);
      const opposite = direction === 'undo' ? 'redo' : 'undo';
      const document = { ...source[source.length - 1],
        ...(snapshot.document.sessionMediaAssetIds === undefined ? {} : { sessionMediaAssetIds: snapshot.document.sessionMediaAssetIds }),
        revision: snapshot.document.revision + 1, updatedAt: new Date().toISOString() };
      await validateAssets(document.layers);
      return save({ formatVersion: 1, document, history: { ...snapshot.history,
        [direction]: source.slice(0, -1), [opposite]: [...snapshot.history[opposite], historyState(snapshot.document)] } });
    });
  }

  async function drain(): Promise<void> { await Promise.allSettled([...pending.values()]); }
  return { create, get, list, edit, insertLatest, openAsset, travel, drain };
}

export type Documents = ReturnType<typeof createDocuments>;
