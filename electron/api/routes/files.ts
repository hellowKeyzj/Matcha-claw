import type { IncomingMessage, ServerResponse } from 'http';
import { dialog, nativeImage } from 'electron';
import crypto from 'node:crypto';
import { basename, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { FileApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const EXT_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
};

function getMimeType(ext: string): string {
  return EXT_MIME_MAP[ext.toLowerCase()] || 'application/octet-stream';
}

function mimeToExt(mimeType: string): string {
  for (const [ext, mime] of Object.entries(EXT_MIME_MAP)) {
    if (mime === mimeType) return ext;
  }
  return '';
}

const OUTBOUND_DIR = join(homedir(), '.openclaw', 'media', 'outbound');
const FILE_PREVIEW_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const FILE_PREVIEW_MAX_BINARY_BYTES = 50 * 1024 * 1024;
const FILE_PREVIEW_DIR_BLACKLIST = new Set([
  'node_modules',
  '.venv',
  '__pycache__',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
]);

interface FilePreviewDirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  hasChildren?: boolean;
}

function expandPreviewPath(input: string): string {
  if (input === '~') {
    return homedir();
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

async function resolvePreviewPath(input: string): Promise<string> {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('notFound');
  }
  const expanded = expandPreviewPath(input.trim());
  const fsP = await import('node:fs/promises');
  try {
    return await fsP.realpath(expanded);
  } catch {
    return resolve(expanded);
  }
}

function looksLikeBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8192);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

async function statPreviewTarget(inputPath: string) {
  const realPath = await resolvePreviewPath(inputPath);
  const fsP = await import('node:fs/promises');
  const stat = await fsP.stat(realPath);
  return { realPath, stat };
}

function mapPreviewError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'binary') {
    return 'binary';
  }
  if (message === 'tooLarge') {
    return 'tooLarge';
  }
  if (message === 'notDirectory') {
    return 'notDirectory';
  }
  if (message.includes('ENOENT')) {
    return 'notFound';
  }
  return message || 'unknown';
}

function toDirEntry(path: string, stat: { isDirectory(): boolean; size: number; mtimeMs: number }): FilePreviewDirEntry {
  return {
    name: basename(path),
    path,
    isDir: stat.isDirectory(),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

async function readPreviewTextFile(inputPath: string, maxBytes?: number) {
  const { realPath, stat } = await statPreviewTarget(inputPath);
  if (!stat.isFile()) {
    throw new Error('notFound');
  }
  const cap = Math.max(1, Math.min(maxBytes ?? FILE_PREVIEW_MAX_TEXT_BYTES, FILE_PREVIEW_MAX_TEXT_BYTES));
  if (stat.size > cap) {
    throw new Error('tooLarge');
  }
  const fsP = await import('node:fs/promises');
  const buffer = await fsP.readFile(realPath);
  if (looksLikeBinary(buffer)) {
    throw new Error('binary');
  }
  return {
    path: realPath,
    content: buffer.toString('utf8'),
    mimeType: getMimeType(extname(realPath)),
    size: stat.size,
    readOnly: true,
  };
}

async function readPreviewBinaryFile(inputPath: string, maxBytes?: number) {
  const { realPath, stat } = await statPreviewTarget(inputPath);
  if (!stat.isFile()) {
    throw new Error('notFound');
  }
  const cap = Math.max(1, Math.min(maxBytes ?? FILE_PREVIEW_MAX_BINARY_BYTES, FILE_PREVIEW_MAX_BINARY_BYTES));
  if (stat.size > cap) {
    throw new Error('tooLarge');
  }
  const fsP = await import('node:fs/promises');
  const buffer = await fsP.readFile(realPath);
  return {
    path: realPath,
    data: buffer.toString('base64'),
    mimeType: getMimeType(extname(realPath)),
    size: stat.size,
    readOnly: true,
  };
}

async function listPreviewDir(inputPath: string, includeHidden = false): Promise<FilePreviewDirEntry[]> {
  const { realPath, stat } = await statPreviewTarget(inputPath);
  if (!stat.isDirectory()) {
    throw new Error('notDirectory');
  }
  const fsP = await import('node:fs/promises');
  const entries = await fsP.readdir(realPath, { withFileTypes: true });
  const results: FilePreviewDirEntry[] = [];

  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isDirectory() && FILE_PREVIEW_DIR_BLACKLIST.has(entry.name)) {
      continue;
    }
    if (!entry.isDirectory() && !entry.isFile()) {
      continue;
    }
    const childPath = join(realPath, entry.name);
    results.push({
      name: entry.name,
      path: childPath,
      isDir: entry.isDirectory(),
      size: 0,
      mtimeMs: 0,
      hasChildren: entry.isDirectory() ? true : false,
    });
  }

  return results.sort((left, right) => {
    if (left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

async function generateImagePreview(filePath: string, mimeType: string): Promise<string | null> {
  try {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const maxDim = 512;
    if (size.width > maxDim || size.height > maxDim) {
      const resized = size.width >= size.height
        ? img.resize({ width: maxDim })
        : img.resize({ height: maxDim });
      return `data:image/png;base64,${resized.toPNG().toString('base64')}`;
    }
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(filePath);
    return `data:${mimeType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function resolveOutgoingMediaUrl(
  gatewayUrl: string,
): Promise<{ path: string; mimeType: string } | null> {
  try {
    const matched = gatewayUrl.match(/\/api\/chat\/media\/outgoing\/[^/]+\/([^/]+)\//);
    if (!matched) {
      return null;
    }
    const attachmentId = decodeURIComponent(matched[1] ?? '');
    if (!attachmentId || !/^[A-Za-z0-9._-]+$/.test(attachmentId)) {
      return null;
    }
    const recordPath = join(homedir(), '.openclaw', 'media', 'outgoing', 'records', `${attachmentId}.json`);
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(recordPath, 'utf8');
    const record = JSON.parse(raw) as {
      original?: {
        path?: string;
        contentType?: string;
      };
    };
    const originalPath = typeof record.original?.path === 'string' ? record.original.path : '';
    if (!originalPath) {
      return null;
    }
    return {
      path: originalPath,
      mimeType: typeof record.original?.contentType === 'string' && record.original.contentType
        ? record.original.contentType
        : 'application/octet-stream',
    };
  } catch {
    return null;
  }
}

export async function handleFileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: FileApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/files/read-text' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ path: string; maxBytes?: number }>(req);
      const result = await readPreviewTextFile(body.path, body.maxBytes);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 200, { ok: false, error: mapPreviewError(error) });
    }
    return true;
  }

  if (url.pathname === '/api/files/read-binary' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ path: string; maxBytes?: number }>(req);
      const result = await readPreviewBinaryFile(body.path, body.maxBytes);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 200, { ok: false, error: mapPreviewError(error) });
    }
    return true;
  }

  if (url.pathname === '/api/files/stat' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ path: string }>(req);
      const { realPath, stat } = await statPreviewTarget(body.path);
      sendJson(res, 200, { ok: true, entry: toDirEntry(realPath, stat) });
    } catch (error) {
      sendJson(res, 200, { ok: false, error: mapPreviewError(error) });
    }
    return true;
  }

  if (url.pathname === '/api/files/list-dir' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ path: string; includeHidden?: boolean }>(req);
      const entries = await listPreviewDir(body.path, body.includeHidden === true);
      sendJson(res, 200, { ok: true, entries });
    } catch (error) {
      sendJson(res, 200, { ok: false, error: mapPreviewError(error) });
    }
    return true;
  }

  if (url.pathname === '/api/files/stage-paths' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ filePaths: string[] }>(req);
      const fsP = await import('node:fs/promises');
      await fsP.mkdir(OUTBOUND_DIR, { recursive: true });
      const results = [];
      for (const filePath of body.filePaths) {
        const id = crypto.randomUUID();
        const ext = extname(filePath);
        const stagedPath = join(OUTBOUND_DIR, `${id}${ext}`);
        await fsP.copyFile(filePath, stagedPath);
        const s = await fsP.stat(stagedPath);
        const mimeType = getMimeType(ext);
        const fileName = filePath.split(/[\\/]/).pop() || 'file';
        const preview = mimeType.startsWith('image/')
          ? await generateImagePreview(stagedPath, mimeType)
          : null;
        results.push({ id, fileName, mimeType, fileSize: s.size, stagedPath, preview });
      }
      sendJson(res, 200, results);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/files/stage-buffer' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ base64: string; fileName: string; mimeType: string }>(req);
      const fsP = await import('node:fs/promises');
      await fsP.mkdir(OUTBOUND_DIR, { recursive: true });
      const id = crypto.randomUUID();
      const ext = extname(body.fileName) || mimeToExt(body.mimeType);
      const stagedPath = join(OUTBOUND_DIR, `${id}${ext}`);
      const buffer = Buffer.from(body.base64, 'base64');
      await fsP.writeFile(stagedPath, buffer);
      const mimeType = body.mimeType || getMimeType(ext);
      const preview = mimeType.startsWith('image/')
        ? await generateImagePreview(stagedPath, mimeType)
        : null;
      sendJson(res, 200, {
        id,
        fileName: body.fileName,
        mimeType,
        fileSize: buffer.length,
        stagedPath,
        preview,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/files/thumbnails' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        paths: Array<{ filePath?: string; gatewayUrl?: string; mimeType: string }>;
      }>(req);
      const fsP = await import('node:fs/promises');
      const results: Record<string, { preview: string | null; fileSize: number }> = {};
      for (const entry of body.paths) {
        const fileKey = typeof entry.filePath === 'string' && entry.filePath.trim() ? entry.filePath : null;
        if (fileKey) {
          try {
            const s = await fsP.stat(fileKey);
            const preview = entry.mimeType.startsWith('image/')
              ? await generateImagePreview(fileKey, entry.mimeType)
              : null;
            results[fileKey] = { preview, fileSize: s.size };
          } catch {
            results[fileKey] = { preview: null, fileSize: 0 };
          }
          continue;
        }
        const gatewayKey = typeof entry.gatewayUrl === 'string' && entry.gatewayUrl.trim() ? entry.gatewayUrl : null;
        if (!gatewayKey) {
          continue;
        }
        const resolved = await resolveOutgoingMediaUrl(gatewayKey);
        if (!resolved) {
          results[gatewayKey] = { preview: null, fileSize: 0 };
          continue;
        }
        try {
          const s = await fsP.stat(resolved.path);
          const preview = resolved.mimeType.startsWith('image/')
            ? await generateImagePreview(resolved.path, resolved.mimeType)
            : null;
          results[gatewayKey] = { preview, fileSize: s.size };
        } catch {
          results[gatewayKey] = { preview: null, fileSize: 0 };
        }
      }
      sendJson(res, 200, results);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/files/save-image' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        base64?: string;
        mimeType?: string;
        filePath?: string;
        defaultFileName: string;
      }>(req);
      const ext = body.defaultFileName.includes('.')
        ? body.defaultFileName.split('.').pop()!
        : (body.mimeType?.split('/')[1] || 'png');
      const result = await dialog.showSaveDialog({
        defaultPath: join(homedir(), 'Downloads', body.defaultFileName),
        filters: [
          { name: 'Images', extensions: [ext, 'png', 'jpg', 'jpeg', 'webp', 'gif'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) {
        sendJson(res, 200, { success: false });
        return true;
      }
      const fsP = await import('node:fs/promises');
      if (body.filePath) {
        await fsP.copyFile(body.filePath, result.filePath);
      } else if (body.base64) {
        await fsP.writeFile(result.filePath, Buffer.from(body.base64, 'base64'));
      } else {
        sendJson(res, 400, { success: false, error: 'No image data provided' });
        return true;
      }
      sendJson(res, 200, { success: true, savedPath: result.filePath });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
