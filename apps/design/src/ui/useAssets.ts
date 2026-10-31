import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import type { Asset } from '../document';
import { call } from './api';
import { t } from './i18n';

export interface LoadedAsset {
  asset: Asset;
  url: string;
  image?: HTMLImageElement;
  release(): void;
}

type AssetEntry = Omit<LoadedAsset, 'release'> & { leases: number; poster?: LoadedAsset };

export function useAssets() {
  const cache = useMemo(() => ({
    entries: new Map<string, AssetEntry>(),
    pending: new Map<string, Promise<AssetEntry>>(),
    resources: new Set<AssetEntry>(),
    images: new Map<string, HTMLImageElement>(),
    epoch: 0,
    disposed: false,
  }), []);
  const [images, setImages] = useState<ReadonlyMap<string, HTMLImageElement>>(cache.images);

  const dispose = useCallback((entry: AssetEntry) => {
    if (cache.resources.delete(entry)) {
      if (entry.asset.mimeType.startsWith('image/')) entry.image?.removeAttribute('src');
      URL.revokeObjectURL(entry.url);
    }
    entry.poster?.release();
    entry.poster = undefined;
  }, [cache]);

  useLayoutEffect(() => {
    cache.disposed = false;
    setImages(cache.images);
    return () => {
      cache.disposed = true;
      cache.epoch++;
      for (const entry of cache.resources) dispose(entry);
      cache.entries.clear();
      cache.pending.clear();
      cache.images = new Map();
    };
  }, [cache, dispose]);

  const load = useCallback(async function loadAsset(assetId: string): Promise<LoadedAsset> {
    const epoch = cache.epoch;
    const assertCurrent = () => {
      if (cache.disposed || cache.epoch !== epoch) throw new Error(t('文档已切换'));
    };
    // Child layout effects restart before the cache owner's StrictMode setup.
    await Promise.resolve();
    assertCurrent();
    let entry = cache.entries.get(assetId);
    if (!entry) {
      let pending = cache.pending.get(assetId);
      if (!pending) {
        pending = (async () => {
          const { asset, data } = await call<{ asset: Asset; data: string }>('asset_read', { assetId });
          assertCurrent();
          const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
          const resource: AssetEntry = { asset, url: URL.createObjectURL(new Blob([bytes], { type: asset.mimeType })), leases: 0 };
          cache.resources.add(resource);
          try {
            if (asset.mimeType.startsWith('image/')) {
              resource.image = new Image();
              resource.image.src = resource.url;
              await resource.image.decode();
            } else if (asset.mimeType.startsWith('video/') && asset.posterAssetId) {
              resource.poster = await loadAsset(asset.posterAssetId);
              resource.image = resource.poster.image;
            }
            assertCurrent();
            cache.entries.set(assetId, resource);
            if (resource.image) {
              cache.images = new Map(cache.images).set(assetId, resource.image);
              setImages(cache.images);
            }
            return resource;
          } catch (error) {
            dispose(resource);
            throw error;
          }
        })();
        cache.pending.set(assetId, pending);
        const request = pending;
        void request.finally(() => {
          if (cache.pending.get(assetId) === request) cache.pending.delete(assetId);
        }).catch(() => {});
      }
      entry = await pending;
    }
    assertCurrent();
    const retained = entry;
    retained.leases++;
    let released = false;
    return {
      asset: retained.asset,
      url: retained.url,
      image: retained.image,
      release() {
        if (released) return;
        released = true;
        if (--retained.leases) return;
        if (cache.entries.get(assetId) === retained) cache.entries.delete(assetId);
        if (!cache.disposed && cache.epoch === epoch && cache.images.has(assetId)) {
          cache.images = new Map(cache.images);
          cache.images.delete(assetId);
          setImages(cache.images);
        }
        dispose(retained);
      },
    };
  }, [cache, dispose]);

  return { load, images, entries: cache.entries };
}
