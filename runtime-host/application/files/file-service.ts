import { basename, dirname, extname, join, resolve } from 'node:path';
import type {
  RuntimeFileSystemPort,
  RuntimeIdGeneratorPort,
  RuntimeSystemEnvironmentPort,
} from '../common/runtime-ports';
import type { OpenClawEnvironmentRepository } from '../openclaw/openclaw-environment-repository';

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

interface FileServiceDeps {
  fileSystem: RuntimeFileSystemPort;
  systemEnvironment: RuntimeSystemEnvironmentPort;
  environment: OpenClawEnvironmentRepository;
  idGenerator: RuntimeIdGeneratorPort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getMimeType(ext: string): string {
  return EXT_MIME_MAP[ext.toLowerCase()] || 'application/octet-stream';
}

function mimeToExt(mimeType: string): string {
  for (const [ext, mime] of Object.entries(EXT_MIME_MAP)) {
    if (mime === mimeType) {
      return ext;
    }
  }
  return '';
}

function looksLikeBinary(buffer: Uint8Array): boolean {
  const limit = Math.min(buffer.length, 8192);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function toBase64(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString('base64');
}

function fromBase64(value: string): Uint8Array {
  return Buffer.from(value, 'base64');
}

function mapPreviewError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'binary' || message === 'tooLarge' || message === 'notDirectory') {
    return message;
  }
  if (message.includes('ENOENT')) {
    return 'notFound';
  }
  return message || 'unknown';
}

export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  async readText(payload: unknown) {
    try {
      const body = isRecord(payload) ? payload : {};
      const inputPath = typeof body.path === 'string' ? body.path : '';
      const maxBytes = typeof body.maxBytes === 'number' ? body.maxBytes : undefined;
      const { realPath, stat } = await this.statPreviewTarget(inputPath);
      if (!stat.isFile) {
        throw new Error('notFound');
      }
      const cap = Math.max(1, Math.min(maxBytes ?? FILE_PREVIEW_MAX_TEXT_BYTES, FILE_PREVIEW_MAX_TEXT_BYTES));
      if (stat.size > cap) {
        throw new Error('tooLarge');
      }
      const buffer = await this.deps.fileSystem.readBinaryFile(realPath);
      if (looksLikeBinary(buffer)) {
        throw new Error('binary');
      }
      return {
        ok: true,
        path: realPath,
        content: Buffer.from(buffer).toString('utf8'),
        mimeType: getMimeType(extname(realPath)),
        size: stat.size,
        readOnly: true,
      };
    } catch (error) {
      return { ok: false, error: mapPreviewError(error) };
    }
  }

  async writeText(payload: unknown) {
    try {
      const body = isRecord(payload) ? payload : {};
      const inputPath = typeof body.path === 'string' ? body.path : '';
      const content = typeof body.content === 'string' ? body.content : undefined;
      if (content === undefined) {
        throw new Error('content is required');
      }
      const targetPath = await this.resolveWritablePath(inputPath);
      await this.deps.fileSystem.ensureDirectory(dirname(targetPath));
      await this.deps.fileSystem.writeTextFile(targetPath, content);
      return {
        ok: true,
        path: targetPath,
      };
    } catch (error) {
      return { ok: false, error: mapPreviewError(error) };
    }
  }

  async readBinary(payload: unknown) {
    try {
      const body = isRecord(payload) ? payload : {};
      const inputPath = typeof body.path === 'string' ? body.path : '';
      const maxBytes = typeof body.maxBytes === 'number' ? body.maxBytes : undefined;
      const { realPath, stat } = await this.statPreviewTarget(inputPath);
      if (!stat.isFile) {
        throw new Error('notFound');
      }
      const cap = Math.max(1, Math.min(maxBytes ?? FILE_PREVIEW_MAX_BINARY_BYTES, FILE_PREVIEW_MAX_BINARY_BYTES));
      if (stat.size > cap) {
        throw new Error('tooLarge');
      }
      const buffer = await this.deps.fileSystem.readBinaryFile(realPath);
      return {
        ok: true,
        path: realPath,
        data: toBase64(buffer),
        mimeType: getMimeType(extname(realPath)),
        size: stat.size,
        readOnly: true,
      };
    } catch (error) {
      return { ok: false, error: mapPreviewError(error) };
    }
  }

  async stat(payload: unknown) {
    try {
      const body = isRecord(payload) ? payload : {};
      const inputPath = typeof body.path === 'string' ? body.path : '';
      const { realPath, stat } = await this.statPreviewTarget(inputPath);
      return {
        ok: true,
        entry: {
          name: basename(realPath),
          path: realPath,
          isDir: stat.isDirectory,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        },
      };
    } catch (error) {
      return { ok: false, error: mapPreviewError(error) };
    }
  }

  async listDir(payload: unknown) {
    try {
      const body = isRecord(payload) ? payload : {};
      const inputPath = typeof body.path === 'string' ? body.path : '';
      const includeHidden = body.includeHidden === true;
      const { realPath, stat } = await this.statPreviewTarget(inputPath);
      if (!stat.isDirectory) {
        throw new Error('notDirectory');
      }
      const entries = await this.deps.fileSystem.listDirectory(realPath);
      const results = entries
        .filter((entry) => includeHidden || !entry.name.startsWith('.'))
        .filter((entry) => !entry.isDirectory || !FILE_PREVIEW_DIR_BLACKLIST.has(entry.name))
        .filter((entry) => entry.isDirectory || entry.isFile)
        .map((entry) => ({
          name: entry.name,
          path: join(realPath, entry.name),
          isDir: entry.isDirectory,
          size: 0,
          mtimeMs: 0,
          hasChildren: entry.isDirectory,
        }))
        .sort((left, right) => {
          if (left.isDir !== right.isDir) {
            return left.isDir ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });
      return { ok: true, entries: results };
    } catch (error) {
      return { ok: false, error: mapPreviewError(error) };
    }
  }

  async stagePaths(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const filePaths = Array.isArray(body.filePaths)
      ? body.filePaths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    await this.deps.fileSystem.ensureDirectory(this.getOutboundDir());
    const results = [];
    for (const filePath of filePaths) {
      const id = this.deps.idGenerator.randomId();
      const ext = extname(filePath);
      const stagedPath = join(this.getOutboundDir(), `${id}${ext}`);
      await this.deps.fileSystem.copyFile(filePath, stagedPath);
      const stat = await this.deps.fileSystem.stat(stagedPath);
      const mimeType = getMimeType(ext);
      const fileName = filePath.split(/[\\/]/).pop() || 'file';
      results.push({
        id,
        fileName,
        mimeType,
        fileSize: stat.size,
        stagedPath,
        preview: await this.generateImagePreview(stagedPath, mimeType),
      });
    }
    return results;
  }

  async stageBuffer(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const base64 = typeof body.base64 === 'string' ? body.base64 : '';
    const fileName = typeof body.fileName === 'string' ? body.fileName : 'file';
    const requestedMimeType = typeof body.mimeType === 'string' ? body.mimeType : '';
    await this.deps.fileSystem.ensureDirectory(this.getOutboundDir());
    const id = this.deps.idGenerator.randomId();
    const ext = extname(fileName) || mimeToExt(requestedMimeType);
    const stagedPath = join(this.getOutboundDir(), `${id}${ext}`);
    const buffer = fromBase64(base64);
    await this.deps.fileSystem.writeBinaryFile(stagedPath, buffer);
    const mimeType = requestedMimeType || getMimeType(ext);
    return {
      id,
      fileName,
      mimeType,
      fileSize: buffer.length,
      stagedPath,
      preview: await this.generateImagePreview(stagedPath, mimeType),
    };
  }

  async thumbnails(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const paths = Array.isArray(body.paths) ? body.paths : [];
    const results: Record<string, { preview: string | null; fileSize: number }> = {};
    for (const item of paths) {
      const entry = isRecord(item) ? item : {};
      const fileKey = typeof entry.filePath === 'string' && entry.filePath.trim() ? entry.filePath : null;
      const gatewayKey = typeof entry.gatewayUrl === 'string' && entry.gatewayUrl.trim() ? entry.gatewayUrl : null;
      const mimeType = typeof entry.mimeType === 'string' ? entry.mimeType : 'application/octet-stream';
      if (fileKey) {
        results[fileKey] = await this.buildThumbnail(fileKey, mimeType);
      } else if (gatewayKey) {
        const resolved = await this.resolveOutgoingMediaUrl(gatewayKey);
        results[gatewayKey] = resolved
          ? await this.buildThumbnail(resolved.path, resolved.mimeType)
          : { preview: null, fileSize: 0 };
      }
    }
    return results;
  }

  private getOutboundDir(): string {
    return join(this.deps.environment.getOpenClawConfigDir(), 'media', 'outbound');
  }

  private async buildThumbnail(filePath: string, mimeType: string): Promise<{ preview: string | null; fileSize: number }> {
    try {
      const stat = await this.deps.fileSystem.stat(filePath);
      return {
        preview: await this.generateImagePreview(filePath, mimeType),
        fileSize: stat.size,
      };
    } catch {
      return { preview: null, fileSize: 0 };
    }
  }

  private async generateImagePreview(filePath: string, mimeType: string): Promise<string | null> {
    if (!mimeType.startsWith('image/')) {
      return null;
    }
    try {
      const buffer = await this.deps.fileSystem.readBinaryFile(filePath);
      return `data:${mimeType};base64,${toBase64(buffer)}`;
    } catch {
      return null;
    }
  }

  private expandPreviewPath(input: string): string {
    if (input === '~') {
      return this.deps.systemEnvironment.homeDir;
    }
    if (input.startsWith('~/') || input.startsWith('~\\')) {
      return join(this.deps.systemEnvironment.homeDir, input.slice(2));
    }
    return input;
  }

  private async resolvePreviewPath(input: string): Promise<string> {
    if (typeof input !== 'string' || !input.trim()) {
      throw new Error('notFound');
    }
    const expanded = this.expandPreviewPath(input.trim());
    try {
      return await this.deps.fileSystem.realPath(expanded);
    } catch {
      return resolve(expanded);
    }
  }

  private async resolveWritablePath(input: string): Promise<string> {
    if (typeof input !== 'string' || !input.trim()) {
      throw new Error('notFound');
    }
    const expanded = this.expandPreviewPath(input.trim());
    return resolve(expanded);
  }

  private async statPreviewTarget(inputPath: string) {
    const realPath = await this.resolvePreviewPath(inputPath);
    const stat = await this.deps.fileSystem.stat(realPath);
    return { realPath, stat };
  }

  private async resolveOutgoingMediaUrl(
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
      const recordPath = join(
        this.deps.environment.getOpenClawConfigDir(),
        'media',
        'outgoing',
        'records',
        `${attachmentId}.json`,
      );
      const record = JSON.parse(await this.deps.fileSystem.readTextFile(recordPath)) as {
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
}
