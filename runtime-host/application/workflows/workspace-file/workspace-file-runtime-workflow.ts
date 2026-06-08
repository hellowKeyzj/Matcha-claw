import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  RuntimeFileSystemPort,
  RuntimeIdGeneratorPort,
  RuntimeSystemEnvironmentPort,
} from '../../common/runtime-ports';
import {
  runtimeEndpointsEqual,
  type RuntimeScope,
  type SessionIdentity,
  type WorkspaceFileTarget,
  type WorkspaceStagingTarget,
} from '../../agent-runtime/contracts/runtime-address';
import type { FileRuntimeDataStorePort } from '../../files/file-service';

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
const FILE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
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

export interface WorkspaceFileWorkspaceRootPort {
  getWorkspaceDirForSession(sessionKey: string): Promise<string>;
  getMainWorkspaceDir(): Promise<string>;
  getTaskWorkspaceDirs(): Promise<string[]>;
}

export interface WorkspaceFileRuntimeWorkflowDeps {
  fileSystem: RuntimeFileSystemPort;
  systemEnvironment: RuntimeSystemEnvironmentPort;
  runtimeDataStore: FileRuntimeDataStorePort;
  idGenerator: RuntimeIdGeneratorPort;
  workspaceRoots?: WorkspaceFileWorkspaceRootPort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSessionIdentity(value: unknown): value is SessionIdentity {
  return isRecord(value)
    && isRecord(value.endpoint)
    && typeof value.agentId === 'string'
    && typeof value.sessionKey === 'string';
}

function isWorkspaceFileTarget(value: unknown): value is WorkspaceFileTarget {
  return isRecord(value) && value.kind === 'workspace-file' && typeof value.path === 'string' && isSessionIdentity(value.identity);
}

function isWorkspaceStagingTarget(value: unknown): value is WorkspaceStagingTarget {
  return isRecord(value) && value.kind === 'workspace-staging' && isSessionIdentity(value.identity);
}

function sessionIdentitiesMatch(left: SessionIdentity, right: SessionIdentity): boolean {
  return left.agentId === right.agentId
    && left.sessionKey === right.sessionKey
    && runtimeEndpointsEqual(left.endpoint, right.endpoint);
}

function sessionIdentityOwnerKeys(identity: SessionIdentity): string[] {
  return [
    identity.sessionKey,
    `agent:${identity.agentId}:${identity.sessionKey}`,
  ];
}

function normalizePathForCompare(pathname: string): string {
  return resolve(pathname);
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? normalizePathForCompare(left).toLowerCase() === normalizePathForCompare(right).toLowerCase()
    : normalizePathForCompare(left) === normalizePathForCompare(right);
}

function isPathInsideRoot(pathname: string, root: string): boolean {
  const normalizedPath = normalizePathForCompare(pathname);
  const normalizedRoot = normalizePathForCompare(root);
  const relativePath = relative(normalizedRoot, normalizedPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
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

function estimateBase64DecodedBytes(value: string): number {
  const normalized = value.replace(/\s/g, '');
  if (!normalized) {
    return 0;
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function mapPreviewError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'binary' || message === 'tooLarge' || message === 'notDirectory' || message === 'forbidden' || message === 'pathMismatch' || message === 'invalidTarget') {
    return message;
  }
  if (message.includes('ENOENT')) {
    return 'notFound';
  }
  return message || 'unknown';
}

export class WorkspaceFileRuntimeWorkflow {
  constructor(private readonly deps: WorkspaceFileRuntimeWorkflowDeps) {}

  async readText(payload: unknown) {
    try {
      const body = isRecord(payload) ? payload : {};
      const maxBytes = typeof body.maxBytes === 'number' ? body.maxBytes : undefined;
      const { realPath, stat } = await this.statPreviewPayloadTarget(body);
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
      const content = typeof body.content === 'string' ? body.content : undefined;
      if (content === undefined) {
        throw new Error('content is required');
      }
      if (Buffer.byteLength(content, 'utf8') > FILE_PREVIEW_MAX_TEXT_BYTES) {
        throw new Error('tooLarge');
      }
      const targetPath = await this.resolveWritablePayloadTarget(body);
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
      const maxBytes = typeof body.maxBytes === 'number' ? body.maxBytes : undefined;
      const { realPath, stat } = await this.statPreviewPayloadTarget(body);
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
      const { realPath, stat } = await this.statPreviewPayloadTarget(body);
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
      const includeHidden = body.includeHidden === true;
      const { realPath, stat } = await this.statPreviewPayloadTarget(body);
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
    const filePaths = await this.resolveStagePathPayloadTargets(body);
    await this.deps.fileSystem.ensureDirectory(this.getOutboundDir());
    const results = [];
    for (const filePath of filePaths) {
      const stat = await this.deps.fileSystem.stat(filePath);
      if (!stat.isFile) {
        throw new Error('notFound');
      }
      if (stat.size > FILE_PREVIEW_MAX_BINARY_BYTES) {
        throw new Error('tooLarge');
      }
      const id = this.deps.idGenerator.randomId();
      const ext = extname(filePath);
      const stagedPath = join(this.getOutboundDir(), `${id}${ext}`);
      await this.deps.fileSystem.copyFile(filePath, stagedPath);
      const mimeType = getMimeType(ext);
      const fileName = filePath.split(/[\\/]/).pop() || 'file';
      results.push({
        id,
        fileName,
        mimeType,
        fileSize: stat.size,
        stagedPath,
        preview: await this.generateImagePreview(stagedPath, mimeType, stat.size),
      });
    }
    return results;
  }

  async stageBuffer(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    this.assertWorkspaceStagingPayloadTarget(body);
    const base64 = typeof body.base64 === 'string' ? body.base64 : '';
    const fileName = typeof body.fileName === 'string' ? body.fileName : 'file';
    const requestedMimeType = typeof body.mimeType === 'string' ? body.mimeType : '';
    if (estimateBase64DecodedBytes(base64) > FILE_PREVIEW_MAX_BINARY_BYTES) {
      throw new Error('tooLarge');
    }
    await this.deps.fileSystem.ensureDirectory(this.getOutboundDir());
    const id = this.deps.idGenerator.randomId();
    const ext = extname(fileName) || mimeToExt(requestedMimeType);
    const stagedPath = join(this.getOutboundDir(), `${id}${ext}`);
    const buffer = fromBase64(base64);
    if (buffer.length > FILE_PREVIEW_MAX_BINARY_BYTES) {
      throw new Error('tooLarge');
    }
    await this.deps.fileSystem.writeBinaryFile(stagedPath, buffer);
    const mimeType = requestedMimeType || getMimeType(ext);
    return {
      id,
      fileName,
      mimeType,
      fileSize: buffer.length,
      stagedPath,
      preview: await this.generateImagePreview(stagedPath, mimeType, buffer.length),
    };
  }

  async thumbnail(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const { target, inputPath } = this.readWorkspaceFilePayloadTarget(body);
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType : 'application/octet-stream';
    const resolvedGatewayMedia = await this.resolveOutgoingMediaUrl(inputPath, target.identity);
    if (resolvedGatewayMedia) {
      return await this.buildThumbnail(resolvedGatewayMedia.path, resolvedGatewayMedia.mimeType);
    }
    if (this.isOutgoingMediaUrl(inputPath)) {
      return { preview: null, fileSize: 0 };
    }
    const realPath = await this.resolvePreviewPayloadTarget(body);
    return await this.buildThumbnail(realPath, mimeType || getMimeType(extname(inputPath)));
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
    return join(this.deps.runtimeDataStore.getRuntimeDataRootDir(), 'media', 'outbound');
  }

  private async buildThumbnail(filePath: string, mimeType: string): Promise<{ preview: string | null; fileSize: number }> {
    try {
      const stat = await this.deps.fileSystem.stat(filePath);
      return {
        preview: await this.generateImagePreview(filePath, mimeType, stat.size),
        fileSize: stat.size,
      };
    } catch {
      return { preview: null, fileSize: 0 };
    }
  }

  private async generateImagePreview(filePath: string, mimeType: string, knownSize?: number): Promise<string | null> {
    if (!mimeType.startsWith('image/')) {
      return null;
    }
    try {
      const size = knownSize ?? (await this.deps.fileSystem.stat(filePath)).size;
      if (size > FILE_THUMBNAIL_MAX_BYTES) {
        return null;
      }
      const buffer = await this.deps.fileSystem.readBinaryFile(filePath);
      if (buffer.length > FILE_THUMBNAIL_MAX_BYTES) {
        return null;
      }
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

  private readWorkspaceFilePayloadTarget(body: Record<string, unknown>): { target: WorkspaceFileTarget; inputPath: string } {
    const inputPath = typeof body.path === 'string' ? body.path : '';
    const target = body.target;
    if (!isWorkspaceFileTarget(target)) {
      throw new Error('invalidTarget');
    }
    this.assertWorkspaceFileTargetMetadata(target, body.scope);
    if (!inputPath || target.path !== inputPath) {
      throw new Error('pathMismatch');
    }
    return { target, inputPath };
  }

  private assertWorkspaceFileTargetMetadata(target: WorkspaceFileTarget, scope: unknown): void {
    if (!isRecord(scope) || scope.kind !== 'workspace' || !isRecord(scope.endpoint)) {
      throw new Error('invalidTarget');
    }
    if (target.workspaceId !== scope.workspaceId || target.sourceId !== scope.sourceId) {
      throw new Error('invalidTarget');
    }
    if (!runtimeEndpointsEqual(scope.endpoint as SessionIdentity['endpoint'], target.identity.endpoint)) {
      throw new Error('invalidTarget');
    }
  }

  private assertWorkspaceStagingPayloadTarget(body: Record<string, unknown>): WorkspaceStagingTarget {
    const target = body.target;
    if (!isWorkspaceStagingTarget(target)) {
      throw new Error('invalidTarget');
    }
    const scope = body.scope;
    if (!isRecord(scope) || scope.kind !== 'workspace' || !isRecord(scope.endpoint)) {
      throw new Error('invalidTarget');
    }
    if (!runtimeEndpointsEqual(scope.endpoint as SessionIdentity['endpoint'], target.identity.endpoint)) {
      throw new Error('invalidTarget');
    }
    return target;
  }

  private async resolveWorkspaceRoots(_scope: RuntimeScope | undefined, target: WorkspaceFileTarget | WorkspaceStagingTarget): Promise<string[]> {
    if (!this.deps.workspaceRoots) {
      return [];
    }
    if (!isSessionIdentity(target.identity)) {
      throw new Error('invalidTarget');
    }
    return [await this.deps.workspaceRoots.getWorkspaceDirForSession(target.identity.sessionKey)];
  }

  private async assertPathInWorkspaceRoots(pathname: string, scope: RuntimeScope | undefined, target: WorkspaceFileTarget | WorkspaceStagingTarget): Promise<void> {
    const roots = await this.resolveWorkspaceRoots(scope, target);
    if (roots.length === 0) {
      return;
    }
    const candidatePath = await this.resolvePreviewPath(pathname);
    const realRoots = await Promise.all(roots.map((root) => this.resolvePreviewPath(root)));
    if (!realRoots.some((root) => isPathInsideRoot(candidatePath, root))) {
      throw new Error('forbidden');
    }
  }

  private async resolvePreviewPayloadTarget(body: Record<string, unknown>): Promise<string> {
    const { target, inputPath } = this.readWorkspaceFilePayloadTarget(body);
    const realPath = await this.resolvePreviewPath(target.path);
    await this.assertPathInWorkspaceRoots(inputPath, body.scope as RuntimeScope | undefined, target);
    return realPath;
  }

  private async resolveWritablePayloadTarget(body: Record<string, unknown>): Promise<string> {
    const { target, inputPath } = this.readWorkspaceFilePayloadTarget(body);
    const targetPath = await this.resolveWritablePath(target.path);
    await this.assertPathInWorkspaceRoots(inputPath, body.scope as RuntimeScope | undefined, target);
    try {
      const existingRealPath = await this.deps.fileSystem.realPath(targetPath);
      if (!pathsEqual(existingRealPath, targetPath)) {
        throw new Error('forbidden');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'forbidden') {
        throw error;
      }
    }
    await this.assertWritableParentInWorkspaceRoots(targetPath, body.scope as RuntimeScope | undefined, target);
    return targetPath;
  }

  private async resolveNearestExistingPath(pathname: string): Promise<string> {
    let currentPath = pathname;
    while (!(await this.deps.fileSystem.exists(currentPath))) {
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        return resolve(currentPath);
      }
      currentPath = parentPath;
    }
    return await this.deps.fileSystem.realPath(currentPath);
  }

  private async assertWritableParentInWorkspaceRoots(targetPath: string, scope: RuntimeScope | undefined, target: WorkspaceFileTarget): Promise<void> {
    const realParentPath = await this.resolveNearestExistingPath(dirname(targetPath));
    await this.assertPathInWorkspaceRoots(realParentPath, scope, target);
  }

  private async resolveStagePathPayloadTargets(body: Record<string, unknown>): Promise<string[]> {
    const target = this.assertWorkspaceStagingPayloadTarget(body);
    const filePaths = Array.isArray(body.filePaths)
      ? body.filePaths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const resolvedPaths = await Promise.all(filePaths.map(async (filePath) => {
      const realPath = await this.resolvePreviewPath(filePath);
      await this.assertPathInWorkspaceRoots(realPath, body.scope as RuntimeScope | undefined, target);
      if (!pathsEqual(realPath, filePath)) {
        throw new Error('forbidden');
      }
      return realPath;
    }));
    return resolvedPaths;
  }

  private async statPreviewPayloadTarget(body: Record<string, unknown>) {
    const realPath = await this.resolvePreviewPayloadTarget(body);
    const stat = await this.deps.fileSystem.stat(realPath);
    return { realPath, stat };
  }

  private isOutgoingMediaUrl(pathname: string): boolean {
    return /\/api\/chat\/media\/outgoing\/([^/]+)\/([^/]+)\//.test(pathname);
  }

  private outgoingMediaOwnerMatches(
    record: { sessionIdentity?: unknown; owner?: unknown },
    ownerKey: string,
    identity?: SessionIdentity,
  ): boolean {
    if (identity && isSessionIdentity(record.sessionIdentity)) {
      return sessionIdentitiesMatch(record.sessionIdentity, identity);
    }
    if (identity && sessionIdentityOwnerKeys(identity).includes(ownerKey)) {
      return true;
    }
    if (typeof record.owner === 'string' && record.owner.trim()) {
      return record.owner === ownerKey;
    }
    return false;
  }

  private async resolveOutgoingMediaUrl(
    gatewayUrl: string,
    identity?: SessionIdentity,
  ): Promise<{ path: string; mimeType: string } | null> {
    try {
      const matched = gatewayUrl.match(/\/api\/chat\/media\/outgoing\/([^/]+)\/([^/]+)\//);
      if (!matched) {
        return null;
      }
      const ownerKey = decodeURIComponent(matched[1] ?? '');
      const attachmentId = decodeURIComponent(matched[2] ?? '');
      if (!attachmentId || !/^[A-Za-z0-9._-]+$/.test(attachmentId)) {
        return null;
      }
      const recordPath = join(
        this.deps.runtimeDataStore.getRuntimeDataRootDir(),
        'media',
        'outgoing',
        'records',
        `${attachmentId}.json`,
      );
      const record = JSON.parse(await this.deps.fileSystem.readTextFile(recordPath)) as {
        sessionIdentity?: unknown;
        owner?: unknown;
        original?: {
          path?: string;
          contentType?: string;
        };
      };
      if (!this.outgoingMediaOwnerMatches(record, ownerKey, identity)) {
        return null;
      }
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
