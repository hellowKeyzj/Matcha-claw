import { clipboard, ClipboardItem, nativeImage } from 'electron';
import { crc32 } from 'node:zlib';
import { isAppClipboardWriteRequest, type AppClipboardContent } from '../../../sdk/app-plugins/src/api';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_HTML_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MARKER_FORMATS = ['io.genoffice.slides.slide', 'io.genoffice.slides.elements'] as const;

// Serialize native operations, not clipboard contents: the OS remains the only clipboard owner.
let clipboardOperation: Promise<unknown> = Promise.resolve();

function serializeClipboard<T>(operation: () => Promise<T>): Promise<T> {
  const result = clipboardOperation.then(operation, operation);
  clipboardOperation = result.catch(() => undefined);
  return result;
}

function nativeMarkerType(format: typeof MARKER_FORMATS[number]): string {
  return `electron application/osclipboard;format="${format}"`;
}

function decodeClipboardPng(value: AppClipboardContent['image']): Electron.NativeImage | null {
  if (!value || value.mimeType !== 'image/png' || typeof value.data !== 'string'
    || !value.data.length || value.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)
    || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) return null;
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value.data || bytes.length < 57
    || bytes.readBigUInt64BE(0) !== 0x89504e470d0a1a0an || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384 || width * height > 67_108_864) return null;
  let hasImageData = false;
  let hasEnd = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) return null;
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return null;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if ((type === 'IHDR' && offset !== 8) || ['acTL', 'fcTL', 'fdAT'].includes(type)) return null;
    if (type === 'IDAT') hasImageData = true;
    if (type === 'IEND') {
      if (length || end !== bytes.length || !hasImageData) return null;
      hasEnd = true;
    }
    offset = end;
  }
  if (!hasEnd) return null;
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  return !image.isEmpty() && size.width === width && size.height === height ? image : null;
}

async function readClipboardBytes(item: Electron.ClipboardItem, type: string, maximumBytes: number): Promise<Buffer> {
  const blob = await item.getType(type);
  if (!('size' in blob) || blob.size > maximumBytes) throw new Error('Clipboard content exceeds limit');
  return Buffer.from(await blob.arrayBuffer());
}

async function readNativeClipboard(): Promise<AppClipboardContent> {
  const [item] = await clipboard.read();
  if (!item) return {};
  const content: {
    text?: string;
    html?: string;
    image?: { data: string; mimeType: 'image/png' };
    metadata?: Partial<Record<typeof MARKER_FORMATS[number], string>>;
  } = {};
  if (item.types.includes('text/plain')) content.text = (await readClipboardBytes(item, 'text/plain', MAX_TEXT_BYTES)).toString('utf8');
  if (item.types.includes('text/html')) content.html = (await readClipboardBytes(item, 'text/html', MAX_HTML_BYTES)).toString('utf8');
  if (item.types.includes('image/png')) {
    const bytes = await readClipboardBytes(item, 'image/png', MAX_IMAGE_BYTES);
    content.image = { data: bytes.toString('base64'), mimeType: 'image/png' };
    if (!decodeClipboardPng(content.image)) throw new Error('Invalid clipboard image');
  }
  for (const format of MARKER_FORMATS) {
    const type = nativeMarkerType(format);
    if (!item.types.includes(type)) continue;
    const bytes = await readClipboardBytes(item, type, 256);
    const value = bytes.toString('utf8');
    if (!value.length || !Buffer.from(value).equals(bytes)) {
      throw new Error('Invalid clipboard marker');
    }
    (content.metadata ??= {})[format] = value;
  }
  return content;
}

function hasExpectedMarker(content: AppClipboardContent, value: string): boolean {
  return content.metadata?.['io.genoffice.slides.elements'] === value
    || [...(content.html ?? '').matchAll(/<img\b[^>]*\bdata-genoffice-slides-elements\s*=\s*"([^"]*)"[^>]*>/gi)]
      .some((match) => match[1] === encodeURIComponent(value));
}

function containsWrittenContent(actual: AppClipboardContent, expected: AppClipboardContent, image: Electron.NativeImage | null): boolean {
  if (expected.text !== undefined && actual.text !== expected.text) return false;
  // Chromium may prepend its charset/fragment envelope to the HTML flavor.
  if (expected.html !== undefined && !actual.html?.includes(expected.html)) return false;
  for (const format of MARKER_FORMATS) {
    if (expected.metadata?.[format] !== undefined && actual.metadata?.[format] !== expected.metadata[format]) return false;
  }
  if (image) {
    const readImage = decodeClipboardPng(actual.image);
    if (!readImage || image.getSize().width !== readImage.getSize().width || image.getSize().height !== readImage.getSize().height
      || !image.toBitmap().equals(readImage.toBitmap())) return false;
  }
  return true;
}

type ClipboardWriteResult = { outcome: 'written' | 'denied' | 'invalid-content' | 'clipboard-changed' | 'write-failed' };
type ClipboardReadResult = { outcome: 'read'; content: AppClipboardContent } | { outcome: 'denied' | 'read-failed' };

export function writeAppClipboard(request: unknown, isAuthorized: () => boolean): Promise<ClipboardWriteResult> {
  return serializeClipboard(async (): Promise<ClipboardWriteResult> => {
    if (!isAuthorized()) return { outcome: 'denied' };
    if (!isAppClipboardWriteRequest(request)) return { outcome: 'invalid-content' };
    try {
      const image = request.image ? decodeClipboardPng(request.image) : null;
      if (request.image && !image) return { outcome: 'invalid-content' };
      const formats: Record<string, Blob> = {};
      if (request.text !== undefined) formats['text/plain'] = new Blob([request.text], { type: 'text/plain' });
      if (request.html !== undefined) formats['text/html'] = new Blob([request.html], { type: 'text/html' });
      if (image) {
        const png = image.toPNG();
        if (!png.length || png.length > MAX_IMAGE_BYTES) return { outcome: 'invalid-content' };
        formats['image/png'] = new Blob([new Uint8Array(png)], { type: 'image/png' });
      }
      for (const format of MARKER_FORMATS) {
        const value = request.metadata?.[format];
        if (value !== undefined) formats[nativeMarkerType(format)] = new Blob([value]);
      }
      const item = new ClipboardItem(formats);
      if (request.expected && !hasExpectedMarker(await readNativeClipboard(), request.expected.value)) {
        return { outcome: 'clipboard-changed' };
      }
      if (!isAuthorized()) return { outcome: 'denied' };
      await clipboard.write([item]);
      const actual = await readNativeClipboard();
      return { outcome: containsWrittenContent(actual, request, image) ? 'written' : 'write-failed' };
    } catch {
      return { outcome: 'write-failed' };
    }
  });
}

export function readAppClipboard(isAuthorized: () => boolean): Promise<ClipboardReadResult> {
  return serializeClipboard(async (): Promise<ClipboardReadResult> => {
    if (!isAuthorized()) return { outcome: 'denied' };
    try {
      const content = await readNativeClipboard();
      return isAuthorized() ? { outcome: 'read', content } : { outcome: 'denied' };
    } catch {
      return { outcome: 'read-failed' };
    }
  });
}
