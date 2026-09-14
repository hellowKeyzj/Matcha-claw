import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { getAttachmentStagingDir } from '../../utils/paths';

const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const DIRECTORY_MIME_TYPE = 'application/x-directory';

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

export interface StagedDialogAttachmentPayload {
  stagedAttachmentId?: string;
  entryKind?: 'file' | 'directory';
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  sourcePath?: string;
}

const stagedAttachmentPaths = new Map<string, string>();

/**
 * Releases Main-owned staged attachments that have not entered materialization.
 * This intentionally exposes no custody detail to the caller.
 */
export async function releaseStagedAttachments(stagedAttachmentIds: readonly string[]): Promise<void> {
  const stagedPaths = [...new Set(stagedAttachmentIds)]
    .map((stagedAttachmentId) => {
      const stagedPath = stagedAttachmentPaths.get(stagedAttachmentId);
      stagedAttachmentPaths.delete(stagedAttachmentId);
      return stagedPath;
    })
    .filter((stagedPath): stagedPath is string => Boolean(stagedPath));

  await Promise.all(stagedPaths.map(async (stagedPath) => {
    await unlink(stagedPath).catch(() => undefined);
  }));
}

export async function consumeStagedAttachment(stagedAttachmentId: string): Promise<Buffer> {
  const stagedPath = stagedAttachmentPaths.get(stagedAttachmentId);
  if (!stagedPath) {
    throw new Error('unavailable');
  }
  stagedAttachmentPaths.delete(stagedAttachmentId);

  try {
    const root = await realpath(getAttachmentStagingDir());
    const ownedPath = await realpath(stagedPath);
    if (!isStagingPath(root, ownedPath)) {
      throw new Error('unavailable');
    }
    const metadata = await stat(ownedPath);
    if (!metadata.isFile() || metadata.size > ATTACHMENT_MAX_BYTES) {
      throw new Error('unavailable');
    }
    const content = await readFile(ownedPath);
    if (content.length !== metadata.size) {
      throw new Error('unavailable');
    }
    return content;
  } catch {
    throw new Error('unavailable');
  } finally {
    await unlink(stagedPath).catch(() => undefined);
  }
}

/**
 * Copies a one-shot Main-owned staged attachment to a native dialog destination.
 * The caller supplies only the opaque staged ID; the source path never crosses the boundary.
 */
export async function copyStagedAttachment(
  stagedAttachmentId: string,
  destinationPath: string,
): Promise<void> {
  const stagedPath = stagedAttachmentPaths.get(stagedAttachmentId);
  if (!stagedPath) {
    throw new Error('unavailable');
  }
  stagedAttachmentPaths.delete(stagedAttachmentId);

  try {
    const root = await realpath(getAttachmentStagingDir());
    const ownedPath = await realpath(stagedPath);
    if (!isStagingPath(root, ownedPath)) {
      throw new Error('unavailable');
    }
    const metadata = await stat(ownedPath);
    if (!metadata.isFile() || metadata.size > ATTACHMENT_MAX_BYTES) {
      throw new Error('unavailable');
    }
    await copyFile(ownedPath, destinationPath);
  } catch {
    throw new Error('unavailable');
  } finally {
    await unlink(stagedPath).catch(() => undefined);
  }
}

function getMimeType(ext: string): string {
  return EXT_MIME_MAP[ext.toLowerCase()] || 'application/octet-stream';
}

function safeFileName(value: string): string {
  const name = basename(value);
  return name && name !== '.' && name !== '..' ? name : 'file';
}

async function generateImagePreview(stagedPath: string, mimeType: string, fileSize: number): Promise<string | null> {
  if (!mimeType.startsWith('image/') || fileSize > IMAGE_PREVIEW_MAX_BYTES) {
    return null;
  }

  const buffer = await readFile(stagedPath);
  if (buffer.length > IMAGE_PREVIEW_MAX_BYTES) {
    return null;
  }
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function isFileNotFoundError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ENOENT';
}

function isStagingPath(root: string, candidate: string): boolean {
  const pathWithinStaging = relative(root, candidate);
  return Boolean(pathWithinStaging)
    && !pathWithinStaging.startsWith('..')
    && !pathWithinStaging.includes(':');
}

async function realpathSelectedPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new Error('notFound', { cause: error });
    }
    throw error;
  }
}

async function statSelectedPath(filePath: string): Promise<{ isFile(): boolean; isDirectory?: () => boolean; size: number }> {
  try {
    return await stat(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new Error('notFound', { cause: error });
    }
    throw error;
  }
}

export async function stageWorkspaceMediaAttachment(input: {
  name: string;
  mimeType: string;
  content: Buffer;
  preview?: string | null;
}): Promise<StagedDialogAttachmentPayload> {
  if (!input.name || input.name.includes('\0') || !input.mimeType || input.mimeType.includes('\0')
    || input.content.length > ATTACHMENT_MAX_BYTES) {
    throw new Error('invalid');
  }
  const attachmentStagingDirectory = getAttachmentStagingDir();
  await mkdir(attachmentStagingDirectory, { recursive: true });
  const root = await realpath(attachmentStagingDirectory);
  const id = randomUUID();
  const stagedPath = join(root, `${id}${extname(safeFileName(input.name))}`);
  let written = false;
  try {
    await writeFile(stagedPath, input.content, { flag: 'wx' });
    written = true;
    const ownedPath = await realpath(stagedPath);
    if (!isStagingPath(root, ownedPath)) {
      throw new Error('invalid');
    }
    const metadata = await stat(ownedPath);
    if (!metadata.isFile() || metadata.size !== input.content.length || metadata.size > ATTACHMENT_MAX_BYTES) {
      throw new Error('invalid');
    }
    const preview = input.preview ?? await generateImagePreview(ownedPath, input.mimeType, metadata.size);
    stagedAttachmentPaths.set(id, ownedPath);
    return {
      stagedAttachmentId: id,
      fileName: safeFileName(input.name),
      mimeType: input.mimeType,
      fileSize: metadata.size,
      preview,
    };
  } catch {
    if (written) {
      await unlink(stagedPath).catch(() => undefined);
    }
    throw new Error('invalid');
  }
}

export async function stageRendererBufferAttachment(input: {
  base64: string;
  fileName: string;
  mimeType: string;
}): Promise<StagedDialogAttachmentPayload> {
  if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64) || input.base64.length % 4 !== 0) {
    throw new Error('invalid');
  }
  const content = Buffer.from(input.base64, 'base64');
  if (content.length > ATTACHMENT_MAX_BYTES || content.toString('base64') !== input.base64) {
    throw new Error('invalid');
  }
  return await stageWorkspaceMediaAttachment({
    name: input.fileName,
    mimeType: input.mimeType,
    content,
  });
}

export async function stageDialogSelectedAttachments(filePaths: string[]): Promise<StagedDialogAttachmentPayload[]> {
  let stagingRoot: string | null = null;
  const ensureStagingRoot = async (): Promise<string> => {
    if (stagingRoot) {
      return stagingRoot;
    }
    const attachmentStagingDirectory = getAttachmentStagingDir();
    await mkdir(attachmentStagingDirectory, { recursive: true });
    stagingRoot = await realpath(attachmentStagingDirectory);
    return stagingRoot;
  };

  const attachments: StagedDialogAttachmentPayload[] = [];
  for (const filePath of filePaths) {
    const sourcePath = await realpathSelectedPath(filePath);
    const fileStat = await statSelectedPath(sourcePath);
    if (fileStat.isDirectory?.() === true) {
      attachments.push({
        entryKind: 'directory',
        fileName: basename(sourcePath) || 'folder',
        mimeType: DIRECTORY_MIME_TYPE,
        fileSize: 0,
        preview: null,
        sourcePath,
      });
      continue;
    }
    if (!fileStat.isFile()) {
      throw new Error('notFound');
    }
    if (fileStat.size > ATTACHMENT_MAX_BYTES) {
      throw new Error('tooLarge');
    }

    const ext = extname(sourcePath);
    const mimeType = getMimeType(ext);
    const id = randomUUID();
    const root = await ensureStagingRoot();
    const stagedPath = join(root, `${id}${ext}`);
    let copied = false;
    try {
      await copyFile(sourcePath, stagedPath, constants.COPYFILE_EXCL);
      copied = true;
      const ownedPath = await realpath(stagedPath);
      if (!isStagingPath(root, ownedPath)) {
        throw new Error('invalid');
      }
      const metadata = await stat(ownedPath);
      if (!metadata.isFile() || metadata.size !== fileStat.size || metadata.size > ATTACHMENT_MAX_BYTES) {
        throw new Error('invalid');
      }
      const preview = await generateImagePreview(ownedPath, mimeType, metadata.size);
      stagedAttachmentPaths.set(id, ownedPath);
      attachments.push({
        stagedAttachmentId: id,
        entryKind: 'file',
        fileName: basename(sourcePath) || 'file',
        mimeType,
        fileSize: metadata.size,
        preview,
        sourcePath,
      });
    } catch (error) {
      if (copied) {
        await unlink(stagedPath).catch(() => undefined);
      }
      if (error instanceof Error && (error.message === 'invalid' || error.message === 'tooLarge')) {
        throw error;
      }
      throw new Error('invalid', { cause: error });
    }
  }

  return attachments;
}
