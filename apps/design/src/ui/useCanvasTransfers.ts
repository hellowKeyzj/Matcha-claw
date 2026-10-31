import { useEffect, useRef, useState } from 'react';
import type { Asset, DesignDocument, Edit, ImageLayer, Layer } from '../document';
import { app, call, errorMessage, fileData, isExternalApp } from './api';
import { t } from './i18n';
import type { LoadedAsset } from './useAssets';

export interface Point { x: number; y: number }

interface Options {
  document: DesignDocument;
  current: { readonly current: DesignDocument };
  selected: readonly string[];
  load(assetId: string): Promise<LoadedAsset>;
  edit(edits: Edit[], expectedRevision?: number): Promise<boolean>;
  getCenter(): Point;
  isBlocked(): boolean;
  onSelect(ids: string[]): void;
  onFocus(ids: string[]): void;
  onError(message: string): void;
  onNotice(message: string): void;
}

type CopyState = { status: 'disabled' | 'preparing' | 'ready' | 'writing' | 'failed'; error?: string };
type ImageFile = { blob: Blob; name: string; width: number; height: number };
const clipboardType = 'application/x-matcha-design-layers';
const maximumImages = 50;
const maximumBytes = 20 * 1024 * 1024;
const imageTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };

function imageType(file: File): string | undefined {
  const mime = file.type.toLowerCase();
  return mime ? (mime === 'image/jpg' ? 'image/jpeg' : mime.startsWith('image/') ? mime : undefined) : imageTypes[file.name.split('.').pop()?.toLowerCase() ?? ''];
}

function checkDimensions(width: number, height: number): void {
  if (!(width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 80_000_000)) {
    throw new Error(t('图片尺寸超过限制：单边不超过 16384 像素，总计不超过 8000 万像素。请缩小后重试。'));
  }
}

// Inspect encoded dimensions before asking a decoder to allocate the full image.
function rasterDimensions(bytes: ArrayBuffer): { mimeType: string; width: number; height: number } | undefined {
  const view = new DataView(bytes);
  const tag = (offset: number, length: number) => String.fromCharCode(...new Uint8Array(bytes, offset, length));
  if (bytes.byteLength >= 24 && tag(0, 8) === '\x89PNG\r\n\x1a\n') return { mimeType: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.byteLength >= 10 && ['GIF87a', 'GIF89a'].includes(tag(0, 6))) return { mimeType: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.byteLength >= 26 && tag(0, 2) === 'BM') return { mimeType: 'image/bmp', width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
  if (bytes.byteLength >= 25 && tag(0, 4) === 'RIFF' && tag(8, 4) === 'WEBP') {
    const chunk = tag(12, 4);
    if (chunk === 'VP8X' && bytes.byteLength >= 30) return { mimeType: 'image/webp', width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + (view.getUint32(26, true) >>> 8) };
    if (chunk === 'VP8 ' && bytes.byteLength >= 30) return { mimeType: 'image/webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === 'VP8L' && view.getUint8(20) === 0x2f) {
      const size = view.getUint32(21, true);
      return { mimeType: 'image/webp', width: 1 + (size & 0x3fff), height: 1 + ((size >>> 14) & 0x3fff) };
    }
  }
  if (bytes.byteLength < 4 || view.getUint16(0) !== 0xffd8) return;
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (view.getUint8(offset++) !== 0xff) return;
    while (offset < bytes.byteLength && view.getUint8(offset) === 0xff) offset++;
    if (offset + 3 > bytes.byteLength) return;
    const marker = view.getUint8(offset++);
    if (marker === 0xd9 || marker === 0xda) return;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.byteLength) return;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
      return { mimeType: 'image/jpeg', width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
    }
    offset += length;
  }
}

async function encodePng(image: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const drawing = canvas.getContext('2d');
  if (!drawing) throw new Error(t('图片解码失败'));
  drawing.drawImage(image, 0, 0);
  try {
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(t('图片解码失败'))), 'image/png'));
  } finally { canvas.width = canvas.height = 0; }
}

async function prepareImage(blob: Blob, name: string, signal: AbortSignal, clipboard = false): Promise<ImageFile> {
  if (!blob.size || blob.size > maximumBytes) throw new Error(t('图片文件超过 20 MiB 或为空，请压缩后重试。'));
  const dimensions = rasterDimensions(await blob.arrayBuffer());
  signal.throwIfAborted();
  if (dimensions) checkDimensions(dimensions.width, dimensions.height);
  if (!dimensions && blob.type !== 'image/svg+xml') throw new Error(t('图片格式不受支持，请使用 PNG、JPG、GIF、WebP、BMP 或 SVG。'));
  if (!dimensions) {
    const svg = new DOMParser().parseFromString(await blob.text(), 'image/svg+xml').documentElement;
    if (svg.localName !== 'svg') throw new Error(t('图片解码失败'));
    const viewBox = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const length = (name: string, fallback: number) => {
      const value = svg.getAttribute(name);
      if (!value || value.endsWith('%')) return fallback;
      const match = /^([\d.e+-]+)\s*(px|pt|pc|in|cm|mm|q)?$/i.exec(value.trim());
      const scale: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
      return match ? Number(match[1]) * scale[match[2]?.toLowerCase() ?? 'px'] : NaN;
    };
    checkDimensions(length('width', viewBox[2] || 300), length('height', viewBox[3] || 150));
    signal.throwIfAborted();
  }
  const mimeType = dimensions?.mimeType ?? blob.type;
  if (clipboard && mimeType === 'image/gif') throw new Error(t('暂不支持复制 GIF 原图，请下载后使用。'));
  const typed = blob.slice(0, blob.size, mimeType);
  const url = mimeType === 'image/svg+xml' ? URL.createObjectURL(typed) : undefined;
  let decoded: ImageBitmap | HTMLImageElement | undefined;
  try {
    if (url) {
      const image = new Image();
      image.src = url;
      await image.decode();
      decoded = image;
    } else decoded = await createImageBitmap(typed);
    signal.throwIfAborted();
    const width = decoded instanceof HTMLImageElement ? decoded.naturalWidth : decoded.width;
    const height = decoded instanceof HTMLImageElement ? decoded.naturalHeight : decoded.height;
    checkDimensions(width, height);
    const convert = mimeType === 'image/bmp' || (clipboard && mimeType !== 'image/png');
    const output = convert ? await encodePng(decoded, width, height) : typed;
    signal.throwIfAborted();
    if (output.size > maximumBytes) throw new Error(t('图片文件超过 20 MiB 或为空，请压缩后重试。'));
    return { blob: output, name: convert ? `${name.replace(/\.[^.]+$/, '')}.png` : name, width, height };
  } finally {
    if (url) URL.revokeObjectURL(url);
    if (decoded instanceof ImageBitmap) decoded.close();
  }
}

function imageCount(document: DesignDocument): number { return document.layers.filter((layer) => layer.type === 'image').length; }

export function useCanvasTransfers(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const lifecycle = useRef({ mounted: false, epoch: 0 });
  const transfer = useRef<AbortController | null>(null);
  const buffer = useRef<{ documentId: string; marker: string; layers: Layer[] } | null>(null);
  const prepared = useRef<{ key: string; data: string } | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>({ status: 'disabled' });
  const [copyAttempt, setCopyAttempt] = useState(0);
  const selected = options.document.layers.filter((layer) => options.selected.includes(layer.id));
  const original = selected.length === 1 && selected[0].type === 'image' && selected[0].visible ? selected[0] : undefined;
  const originalKey = original ? `${options.document.id}:${original.id}:${original.assetId}` : '';
  const originalAssetId = original?.assetId;
  const load = options.load;
  const activeOriginalKey = useRef(originalKey);
  activeOriginalKey.current = originalKey;
  const preparedKey = useRef(originalKey);

  useEffect(() => {
    const state = lifecycle.current;
    state.mounted = true;
    const clearBuffer = () => { buffer.current = null; };
    window.addEventListener('blur', clearBuffer);
    return () => {
      state.mounted = false;
      state.epoch++;
      transfer.current?.abort();
      prepared.current = null;
      clearBuffer();
      window.removeEventListener('blur', clearBuffer);
    };
  }, []);

  useEffect(() => {
    buffer.current = null;
    transfer.current?.abort();
    transfer.current = null;
    setImportBusy(false);
  }, [options.document.id]);

  useEffect(() => {
    prepared.current = null;
    preparedKey.current = originalKey;
    if (!originalAssetId) { setCopyState({ status: 'disabled' }); return; }
    if (isExternalApp()) {
      const error = t('当前客户端不支持复制图片，请使用下载原图。');
      setCopyState({ status: 'failed', error });
      return;
    }
    const controller = new AbortController();
    setCopyState({ status: 'preparing' });
    void (async () => {
      const loaded = await load(originalAssetId);
      try {
        controller.signal.throwIfAborted();
        const response = await fetch(loaded.url, { signal: controller.signal });
        if (!response.ok) throw new Error(t('无法读取原图，请重新选择后重试。'));
        const image = await prepareImage(await response.blob(), loaded.asset.name, controller.signal, true);
        const data = await fileData(image.blob);
        if (controller.signal.aborted || activeOriginalKey.current !== originalKey) return;
        prepared.current = { key: originalKey, data };
        setCopyState({ status: 'ready' });
      } finally { loaded.release(); }
    })().catch((cause) => {
      if (controller.signal.aborted || activeOriginalKey.current !== originalKey) return;
      const error = t('原图准备失败：{error}。请重试或下载原图。', { error: errorMessage(cause) });
      setCopyState({ status: 'failed', error });
    });
    return () => controller.abort();
  }, [originalKey, originalAssetId, copyAttempt, load]);

  function isCurrent(documentId: string, epoch: number): boolean {
    return lifecycle.current.mounted && lifecycle.current.epoch === epoch && latest.current.current.current.id === documentId;
  }

  function retryOriginal(): void {
    if (!originalKey || latest.current.isBlocked() || copyState.status === 'preparing' || copyState.status === 'writing') return;
    setCopyState({ status: 'preparing' });
    setCopyAttempt((attempt) => attempt + 1);
  }

  async function writeOriginal(): Promise<void> {
    if (!originalKey || latest.current.isBlocked() || copyState.status === 'preparing' || copyState.status === 'writing') return;
    const png = prepared.current;
    if (!png || png.key !== originalKey) { retryOriginal(); return; }
    const epoch = lifecycle.current.epoch;
    setCopyState({ status: 'writing' });
    try {
      // Keep the actual clipboard write in the click's activation, after background preparation.
      await app().writeClipboardImage({ data: png.data, mimeType: 'image/png' });
      if (!isCurrent(options.document.id, epoch) || activeOriginalKey.current !== png.key) return;
      setCopyState({ status: 'ready' });
      latest.current.onNotice(t('原图已复制到剪贴板'));
    } catch (cause) {
      if (!isCurrent(options.document.id, epoch) || activeOriginalKey.current !== png.key) return;
      const error = errorMessage(cause) || t('图片未能写入剪贴板，请重试或下载原图。');
      setCopyState({ status: 'failed', error });
    }
  }

  async function insertBatch(input: readonly (File | Layer)[], point?: Point): Promise<void> {
    const deps = latest.current;
    if (transfer.current || deps.isBlocked() || !input.length) return;
    let failed = 0;
    let firstError = '';
    const sources = input.filter((source) => {
      if (!(source instanceof File) || (source.size > 0 && source.size <= maximumBytes)) return true;
      failed++;
      firstError ||= t('图片文件超过 20 MiB 或为空，请压缩后重试。');
      return false;
    });
    const before = deps.current.current;
    const requestedImages = sources.filter((source) => source instanceof File || source.type === 'image').length;
    if (imageCount(before) + requestedImages > maximumImages) {
      deps.onError(t('画布最多容纳 50 张图片，请删除部分图片后重试。'));
      return;
    }
    const epoch = lifecycle.current.epoch;
    const controller = new AbortController();
    transfer.current = controller;
    setImportBusy(true);
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (!isCurrent(before.id, epoch)) throw new DOMException('Document changed', 'AbortError');
    };
    const layers: Layer[] = [];
    const copied = sources.filter((source): source is Layer => !(source instanceof File));
    const origin = copied.length ? { x: Math.min(...copied.map((layer) => layer.x)), y: Math.min(...copied.map((layer) => layer.y)) } : undefined;
    const center = deps.getCenter();
    const images = before.layers.filter((layer): layer is ImageLayer => layer.type === 'image');
    const selectedImage = deps.selected.length === 1 ? images.find((layer) => layer.id === deps.selected[0]) : undefined;
    const anchor = selectedImage ?? images.reduce<ImageLayer | undefined>((rightmost, layer) => !rightmost || layer.x + layer.width > rightmost.x + rightmost.width ? layer : rightmost, undefined);
    try {
      for (const source of sources) {
        assertCurrent();
        try {
          if (!(source instanceof File)) {
            const layer = { ...structuredClone(source), id: crypto.randomUUID(), name: t('{name} 副本', { name: source.name }).slice(0, 200), x: source.x + (point && origin ? point.x - origin.x : 24), y: source.y + (point && origin ? point.y - origin.y : 24), locked: false };
            layers.push(layer);
            continue;
          }
          const name = source.name || t('粘贴图片.png');
          const blob = source.slice(0, source.size, imageType(source));
          assertCurrent();
          const image = await prepareImage(blob, name, controller.signal);
          assertCurrent();
          const data = await fileData(image.blob);
          assertCurrent();
          const { asset } = await call<{ asset: Asset }>('asset_import', { name: image.name.slice(0, 200), mimeType: image.blob.type, data });
          assertCurrent();
          const previous = layers.at(-1);
          const position = point ?? (anchor ? { x: anchor.x + anchor.width + 40, y: anchor.y } : { x: center.x - image.width / 2, y: center.y - image.height / 2 });
          const layer: ImageLayer = { id: crypto.randomUUID(), type: 'image', assetId: asset.id, name: asset.name, x: previous ? previous.x + previous.width + 40 : position.x, y: previous ? previous.y : position.y, width: image.width, height: image.height, rotation: 0, opacity: 1, visible: true, locked: false, lockAspectRatio: true };
          layers.push(layer);
        } catch (cause) {
          assertCurrent();
          failed++;
          firstError ||= errorMessage(cause);
        }
      }
      assertCurrent();
      if (layers.length) {
        // The existing mutation owner rejects a stale revision; never retry a partial batch.
        if (!await deps.edit(layers.map((layer) => ({ type: 'insert', layer })), before.revision)) return;
        assertCurrent();
        const ids = layers.map((layer) => layer.id);
        latest.current.onSelect(ids);
        latest.current.onFocus(ids);
      }
      if (failed) latest.current.onError(t('已导入 {count} 项，{failed} 项失败：{error}', { count: layers.length, failed, error: firstError }));
    } catch (cause) {
      if (!controller.signal.aborted && isCurrent(before.id, epoch)) latest.current.onError(errorMessage(cause));
    } finally {
      if (transfer.current === controller) { transfer.current = null; if (isCurrent(before.id, epoch)) setImportBusy(false); }
    }
  }

  async function importFiles(files: readonly File[], point?: Point): Promise<void> {
    const images = files.filter((file) => imageType(file));
    if (!images.length) { latest.current.onError(t('请选择图片文件。')); return; }
    await insertBatch(images, point);
  }

  async function duplicate(point?: Point): Promise<void> {
    const deps = latest.current;
    const layers = deps.current.current.layers.filter((layer) => deps.selected.includes(layer.id));
    await insertBatch(layers, point);
  }

  function handleCopy(event: ClipboardEvent): boolean {
    const deps = latest.current;
    const layers = deps.current.current.layers.filter((layer) => deps.selected.includes(layer.id));
    if (deps.isBlocked() || transfer.current || !layers.length || !event.clipboardData) return false;
    const marker = crypto.randomUUID();
    try { event.clipboardData.setData(clipboardType, marker); }
    catch { buffer.current = null; deps.onError(t('无法写入画布剪贴板，请重新聚焦画布后重试。')); return false; }
    buffer.current = { documentId: deps.current.current.id, marker, layers: structuredClone(layers) };
    event.preventDefault();
    return true;
  }

  function handlePaste(event: ClipboardEvent, point?: Point): boolean {
    const data = event.clipboardData;
    if (!data) return false;
    const internal = buffer.current;
    if (internal && internal.documentId === latest.current.current.current.id && data.getData(clipboardType) === internal.marker) {
      event.preventDefault();
      void insertBatch(internal.layers, point);
      return true;
    }
    buffer.current = null;
    const items = [...data.items].filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file);
    const files = (items.length ? items : [...data.files]).filter((file) => imageType(file));
    if (!files.length) return false;
    event.preventDefault();
    void importFiles(files, point);
    return true;
  }

  const visibleCopyState = preparedKey.current === originalKey ? copyState : { status: originalKey ? 'preparing' as const : 'disabled' as const };
  return { importFiles, duplicate, handleCopy, handlePaste, importBusy, copyOriginal: { ...visibleCopyState, write: writeOriginal, retry: retryOriginal, dismiss: () => setCopyState(({ status }) => ({ status })) } };
}
