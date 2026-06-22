import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { getOpenClawConfigDir } from '../../utils/paths';

const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

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
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  stagedPath: string;
  preview: string | null;
}

function getMimeType(ext: string): string {
  return EXT_MIME_MAP[ext.toLowerCase()] || 'application/octet-stream';
}

function getOutboundMediaDir(): string {
  return join(getOpenClawConfigDir(), 'media', 'outbound');
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

async function statSelectedFile(filePath: string): Promise<{ isFile(): boolean; size: number }> {
  try {
    return await stat(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new Error('notFound');
    }
    throw error;
  }
}

export async function stageDialogSelectedAttachments(filePaths: string[]): Promise<StagedDialogAttachmentPayload[]> {
  const outboundMediaDir = getOutboundMediaDir();
  await mkdir(outboundMediaDir, { recursive: true });

  const attachments: StagedDialogAttachmentPayload[] = [];
  for (const filePath of filePaths) {
    const fileStat = await statSelectedFile(filePath);
    if (!fileStat.isFile()) {
      throw new Error('notFound');
    }
    if (fileStat.size > ATTACHMENT_MAX_BYTES) {
      throw new Error('tooLarge');
    }

    const id = randomUUID();
    const ext = extname(filePath);
    const stagedPath = join(outboundMediaDir, `${id}${ext}`);
    const mimeType = getMimeType(ext);

    await copyFile(filePath, stagedPath);
    attachments.push({
      id,
      fileName: basename(filePath) || 'file',
      mimeType,
      fileSize: fileStat.size,
      stagedPath,
      preview: await generateImagePreview(stagedPath, mimeType, fileStat.size),
    });
  }

  return attachments;
}
