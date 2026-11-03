import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import Konva from 'konva';
import type { AppSessionMediaItem } from '@matcha/app-plugins-sdk';
import type { Asset, DesignDocument, Edit, Layer } from '../document';
import { app, call } from './api';
import { t } from './i18n';

interface Options {
  document: DesignDocument;
  current: { readonly current: DesignDocument };
  blocked: boolean;
  edit(edits: Edit[], expectedRevision?: number): Promise<boolean>;
  onError(message: string): void;
}

function layerForAsset(asset: Asset, document: DesignDocument): Layer {
  const type = asset.mimeType.startsWith('video/') ? 'video' : asset.mimeType.startsWith('image/') ? 'image' : undefined;
  if (!type) throw new Error(t('媒体类型不受设计画板支持。'));
  if (!(asset.width && asset.width > 0 && asset.height && asset.height > 0) || !Number.isFinite(asset.width) || !Number.isFinite(asset.height)) throw new Error(t('媒体缺少有效的原始尺寸。'));
  let right = -Infinity, top = Infinity;
  for (const layer of document.layers) {
    if (!layer.visible) continue;
    const node = new Konva.Rect({ x: layer.x, y: layer.y, width: layer.width, height: layer.height, rotation: layer.rotation });
    const bounds = node.getClientRect();
    node.destroy();
    right = Math.max(right, bounds.x + bounds.width);
    top = Math.min(top, bounds.y);
  }
  return { id: crypto.randomUUID(), type, assetId: asset.id, name: asset.name,
    x: Number.isFinite(right) ? right + 24 : 0, y: Number.isFinite(top) ? top : 0,
    width: asset.width, height: asset.height, rotation: 0, opacity: 1, visible: true, locked: false,
    ...(type === 'image' ? { lockAspectRatio: true } : {}) };
}

function failureCode(cause: unknown): string {
  const code = cause instanceof Error && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && /^[a-z][a-zA-Z0-9_]{0,63}$/.test(code) ? code : '';
}

export function useSessionMedia(options: Options): () => void {
  const latest = useRef(options);
  latest.current = options;
  const signal = useRef<(() => void) | undefined>(undefined);
  const retry = useRef<(() => void) | undefined>(undefined);

  useLayoutEffect(() => { signal.current?.(); }, [options.blocked]);

  useEffect(() => {
    if (!app().context.sessionIdentity) return;
    const documentId = latest.current.document.id;
    const failed = new Set<string>();
    let items: readonly AppSessionMediaItem[] = [];
    let cursor = 0;
    let nextCursor: string | undefined;
    let scanRevision = 0;
    let refresh = true;
    let unavailable = false;
    let oversized = false;
    let unsupported = false;
    let running = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const active = () => !disposed && latest.current.document.id === documentId && latest.current.current.current.id === documentId;
    function schedule(): void {
      if (!active() || running || timer !== undefined || latest.current.blocked || (cursor >= items.length && !refresh && nextCursor === undefined)) return;
      timer = setTimeout(() => { timer = undefined; void run(); }, 0);
    }
    function request(): void {
      if (!active()) return;
      scanRevision++;
      failed.clear();
      items = [];
      cursor = 0;
      nextCursor = undefined;
      refresh = true;
      unavailable = oversized = unsupported = false;
      schedule();
    }
    async function run(): Promise<void> {
      if (!active() || latest.current.blocked) return;
      running = true;
      try {
        if (cursor >= items.length) {
          if (!refresh && nextCursor === undefined) return;
          const continuation = refresh ? undefined : nextCursor;
          const attempt = scanRevision;
          refresh = false;
          nextCursor = undefined;
          try {
            const list = await app().listSessionMedia(continuation === undefined ? undefined : { cursor: continuation });
            if (!active() || attempt !== scanRevision) return;
            items = list.items;
            cursor = 0;
            nextCursor = list.nextCursor;
            unavailable ||= items.some((item) => item.readable === false);
            oversized ||= list.omittedOversized === true;
            unsupported ||= list.historyImages === 'unsupported';
          } catch (cause) {
            if (!active() || attempt !== scanRevision) return;
            const code = failureCode(cause);
            if (code === 'cursorInvalid') {
              items = [];
              cursor = 0;
              latest.current.onError(t('会话媒体分页已失效，请刷新会话媒体后重试。'));
            } else latest.current.onError(`${t('会话媒体列表读取失败')} [list${code ? `/${code}` : ''}]`);
            return;
          }
        }
        // Follow the host's opaque cursor; process at most eight sequential items per turn.
        for (let count = 0; count < 8 && cursor < items.length; count++) {
          if (!active() || latest.current.blocked) return;
          const item = items[cursor];
          if (item.readable === false || failed.has(item.id)) { cursor++; continue; }
          const attempt = scanRevision;
          let stage = 'read';
          try {
            const original = await app().readSessionMedia({ id: item.id });
            if (!active() || attempt !== scanRevision || latest.current.blocked) return;
            stage = 'import';
            const { asset } = await call<{ asset: Asset }>('asset_import', original);
            if (!active() || attempt !== scanRevision) return;
            const before = latest.current.current.current;
            if (before.sessionMediaAssetIds?.includes(asset.id)) {
              cursor++;
              continue;
            }
            if (latest.current.blocked) return;
            stage = 'layout';
            const layer = layerForAsset(asset, before);
            stage = 'edit';
            const saved = await latest.current.edit([{ type: 'insert', layer, source: 'session-media' }], before.revision);
            if (!active()) return;
            if (!saved && attempt === scanRevision) failed.add(item.id);
          } catch (cause) {
            if (!active() || attempt !== scanRevision) return;
            failed.add(item.id);
            const code = failureCode(cause);
            if (code === 'cursorInvalid') {
              items = [];
              cursor = 0;
              nextCursor = undefined;
              latest.current.onError(t('会话媒体分页已失效，请刷新会话媒体后重试。'));
              return;
            }
            const name = Array.from(item.name.split(/[\\/]/).pop() ?? '', (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? '_' : character).join('').slice(0, 200);
            // Host error text can contain native paths or opaque IDs; expose only its stable code.
            const detail = stage === 'layout' && cause instanceof Error ? ` ${cause.message}` : '';
            latest.current.onError(`${t('会话媒体“{name}”自动归集失败', { name })} [${stage}${code ? `/${code}` : ''}]${detail}`);
          }
          if (attempt !== scanRevision) return;
          cursor++;
        }
        if (active() && !latest.current.blocked && cursor >= items.length && nextCursor === undefined) {
          const message = [unavailable && t('部分媒体原件不可读，未自动归集。'), oversized && t('部分超大媒体已省略，未自动归集。'), unsupported && t('当前客户端不支持历史图片，仅归集已加载媒体。')].filter(Boolean).join(' ');
          if (message) latest.current.onError(message);
        }
      } finally {
        running = false;
        schedule();
      }
    }
    const onBlocked = () => schedule();
    signal.current = onBlocked;
    retry.current = request;
    const unsubscribe = app().subscribe((event) => { if (event.topic === 'media.changed') request(); });
    schedule();
    return () => {
      disposed = true;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      if (signal.current === onBlocked) signal.current = undefined;
      if (retry.current === request) retry.current = undefined;
    };
  }, [options.document.id]);
  return useCallback(() => { retry.current?.(); }, []);
}
