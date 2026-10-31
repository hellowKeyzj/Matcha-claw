import { createHash, randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Asset } from '../document';
import { DesignError, readJson, writeAtomic } from './files';
import { dimensions, id, invalid, number, object, text } from './validation';
import { readVideoMetadata } from './video-metadata';

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
const videoTypes = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

export function decodeBase64(data: unknown, maximum: number): Buffer {
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(maximum / 3) * 4
    || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) invalid('data must be non-empty, padded base64 without a data URL prefix.');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== data) invalid('Invalid or oversized base64 data.');
  return bytes;
}

export function createAssets(storagePath: string, packagePath: string) {
  const root = join(storagePath, 'assets');
  const metadataPending = new Map<string, Promise<Asset>>();
  const contentPending = new Map<string, Promise<Asset>>();
  let contentQueued = 0;

  async function readMetadata(assetId: string): Promise<Asset> {
    const assetPath = join(root, `${id(assetId, 'assetId')}.json`);
    let value: unknown;
    try { value = await readJson(assetPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DesignError('asset_not_found', `Asset ${assetId} does not exist.`);
      throw error;
    }
    const raw = object(value, ['id', 'name', 'mimeType', 'width', 'height', 'durationSeconds', 'posterAssetId', 'contentHash']);
    if (raw.id !== assetId || typeof raw.name !== 'string' || typeof raw.mimeType !== 'string'
      || (!imageTypes.has(raw.mimeType) && !videoTypes.has(raw.mimeType))) throw new Error(`Invalid asset metadata: ${assetId}`);
    if (raw.width !== undefined || raw.height !== undefined) dimensions(raw.width as number, raw.height as number);
    if (raw.durationSeconds !== undefined) {
      number(raw.durationSeconds, 'durationSeconds', Number.MIN_VALUE, Number.MAX_SAFE_INTEGER);
      if (!videoTypes.has(raw.mimeType)) invalid('Only video assets may contain durationSeconds.');
    }
    if (raw.posterAssetId !== undefined) {
      id(raw.posterAssetId, 'posterAssetId');
      if (!videoTypes.has(raw.mimeType) || raw.posterAssetId === assetId) invalid('Invalid video poster asset.');
    }
    if (raw.contentHash !== undefined && (typeof raw.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.contentHash))) invalid('Invalid asset contentHash.');
    return raw as unknown as Asset;
  }

  async function describeVideo(asset: Asset, bytes: Buffer, signal?: AbortSignal): Promise<Asset> {
    const metadata = await readVideoMetadata(packagePath, storagePath, bytes, signal);
    const poster = await importBytes(`${asset.name.slice(0, 189)}-poster.png`, 'image/png', metadata.poster, signal);
    return { ...asset, width: metadata.width, height: metadata.height, durationSeconds: metadata.durationSeconds, posterAssetId: poster.id };
  }

  async function removeAsset(assetId: string): Promise<void> {
    await Promise.all([rm(join(root, `${assetId}.json`), { force: true }), rm(join(root, `${assetId}.bin`), { force: true })]);
  }

  async function get(assetId: string): Promise<Asset> {
    id(assetId, 'assetId');
    const existing = metadataPending.get(assetId);
    if (existing) return existing;
    const pending = (async () => {
      let asset = await readMetadata(assetId);
      if (!videoTypes.has(asset.mimeType)) return asset;
      if (asset.width === undefined || asset.height === undefined || asset.durationSeconds === undefined || asset.posterAssetId === undefined) {
        const enriched = await describeVideo(asset, await readFile(join(root, `${asset.id}.bin`)));
        try { await writeAtomic(join(root, `${asset.id}.json`), enriched); }
        catch (error) { await removeAsset(enriched.posterAssetId!); throw error; }
        asset = enriched;
      }
      const poster = await readMetadata(asset.posterAssetId!);
      if (poster.mimeType !== 'image/png' || !poster.width || !poster.height) throw new Error(`Invalid video poster metadata: ${asset.id}`);
      return asset;
    })();
    metadataPending.set(assetId, pending);
    try { return await pending; }
    finally { if (metadataPending.get(assetId) === pending) metadataPending.delete(assetId); }
  }

  async function read(assetId: string): Promise<{ asset: Asset; bytes: Buffer }> {
    const asset = await get(assetId);
    return { asset, bytes: await readFile(join(root, `${asset.id}.bin`)) };
  }

  async function importBytes(name: string, mimeType: string, bytes: Buffer, signal?: AbortSignal): Promise<Asset> {
    signal?.throwIfAborted();
    text(name, 'name', 200);
    if (!imageTypes.has(mimeType) && !videoTypes.has(mimeType)) invalid(`Unsupported asset MIME type: ${mimeType}`);
    if (!bytes.length || bytes.length > (imageTypes.has(mimeType) ? 64 : 256) * 1024 * 1024) invalid('Asset is empty or exceeds the image 64 MiB / video 256 MiB limit.');
    let asset: Asset = { id: randomUUID(), name, mimeType, contentHash: createHash('sha256').update(bytes).digest('hex') };
    if (imageTypes.has(mimeType)) {
      const { loadImage } = await import('skia-canvas');
      const image = await loadImage(bytes);
      dimensions(image.width, image.height);
      asset.width = image.width;
      asset.height = image.height;
    } else {
      const isWebm = bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      const isMp4 = bytes.subarray(4, 8).toString('ascii') === 'ftyp';
      if (mimeType === 'video/webm' ? !isWebm : !isMp4) invalid(`Asset bytes do not match ${mimeType}.`);
      asset = await describeVideo(asset, bytes, signal);
    }
    const path = join(root, `${asset.id}.bin`);
    try {
      signal?.throwIfAborted();
      await mkdir(root, { recursive: true });
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await writeAtomic(join(root, `${asset.id}.json`), asset);
    } catch (error) {
      await rm(path, { force: true });
      if (asset.posterAssetId) await removeAsset(asset.posterAssetId);
      throw error;
    }
    return asset;
  }

  async function importBase64(name: string, mimeType: string, data: unknown, signal?: AbortSignal): Promise<Asset> {
    return importBytes(name, mimeType, decodeBase64(data, (imageTypes.has(mimeType) ? 64 : 256) * 1024 * 1024), signal);
  }

  async function findByContent(mimeType: string, bytes: Buffer): Promise<Asset | undefined> {
    if (!imageTypes.has(mimeType) && !videoTypes.has(mimeType)) invalid(`Unsupported asset MIME type: ${mimeType}`);
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    let entries: string[];
    try { entries = await readdir(root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const asset = await readMetadata(entry.slice(0, -5));
      if (asset.mimeType !== mimeType) continue;
      const hash = asset.contentHash ?? createHash('sha256').update(await readFile(join(root, `${asset.id}.bin`))).digest('hex');
      if (hash === contentHash) return asset;
    }
    return undefined;
  }

  async function importByContent(name: string, mimeType: string, bytes: Buffer, signal?: AbortSignal): Promise<Asset> {
    signal?.throwIfAborted();
    text(name, 'name', 200);
    if (!imageTypes.has(mimeType) && !videoTypes.has(mimeType)) invalid(`Unsupported asset MIME type: ${mimeType}`);
    if (!bytes.length || bytes.length > (imageTypes.has(mimeType) ? 64 : 256) * 1024 * 1024) invalid('Asset is empty or exceeds the image 64 MiB / video 256 MiB limit.');
    if (contentQueued >= 128) throw new DesignError('busy', 'Too many pending asset imports; wait for the current imports to finish.');
    const key = `${mimeType}:${createHash('sha256').update(bytes).digest('hex')}`;
    const previous = contentPending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const asset = await findByContent(mimeType, bytes);
      signal?.throwIfAborted();
      return asset ? get(asset.id) : importBytes(name, mimeType, bytes, signal);
    });
    contentQueued++;
    contentPending.set(key, next);
    return new Promise<Asset>((resolve, reject) => {
      const abort = signal && addAbortListener(signal, () => reject(signal.reason));
      void next.then(resolve, reject).finally(() => {
        abort?.[Symbol.dispose]();
        contentQueued--;
        if (contentPending.get(key) === next) contentPending.delete(key);
      });
    });
  }

  function path(assetId: string): string { return join(root, `${id(assetId, 'assetId')}.bin`); }
  return { get, read, importBytes, importBase64, findByContent, importByContent, path };
}

export type Assets = ReturnType<typeof createAssets>;
