import type { IncomingMessage, ServerResponse } from 'http';
import { dialog } from 'electron';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { copyStagedAttachment } from '../../main/ipc/dialog-attachment-staging';
import type { FileApiContext } from '../context';
import type { WorkspaceBinaryTransport } from '../../main/runtime-host-delivery/transport/workspace/read-binary';
import type { WorkspaceDirectoryTransport } from '../../main/runtime-host-delivery/transport/workspace/read-directory';
import type { WorkspaceTextTransport } from '../../main/runtime-host-delivery/transport/workspace/read-text';
import type { WorkspaceWriteTransport } from '../../main/runtime-host-delivery/transport/workspace/write-text';
import { parseJsonBody, sendJson } from '../route-utils';

export type WorkspaceFileRouteDeps = Readonly<{
  workspaceTextTransport?: WorkspaceTextTransport;
  workspaceBinaryTransport?: WorkspaceBinaryTransport;
  workspaceDirectoryTransport?: WorkspaceDirectoryTransport;
  workspaceWriteTransport?: WorkspaceWriteTransport;
}>;

const UNAVAILABLE = {
  '/api/files/read-text': { success: false, error: 'Workspace text is unavailable' },
  '/api/files/binary': { success: false, error: 'Workspace binary is unavailable' },
  '/api/files/list-dir': { success: false, error: 'Workspace directory is unavailable' },
  '/api/files/write-text': { success: false, error: 'Workspace write is unavailable' },
} as const;

export async function handleFileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps?: FileApiContext | WorkspaceFileRouteDeps,
): Promise<boolean> {
  if (url.pathname === '/api/files/read-text' && req.method === 'POST') {
    const transports = getWorkspaceTransports(deps);
    if (!transports?.workspaceTextTransport) {
      sendJson(res, 503, UNAVAILABLE['/api/files/read-text']);
      return true;
    }
    try {
      const response = await transports.workspaceTextTransport.read(await parseJsonBody<unknown>(req));
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, UNAVAILABLE['/api/files/read-text']);
    }
    return true;
  }

  if (url.pathname === '/api/files/binary' && req.method === 'POST') {
    const transports = getWorkspaceTransports(deps);
    if (!transports?.workspaceBinaryTransport) {
      sendJson(res, 503, UNAVAILABLE['/api/files/binary']);
      return true;
    }
    try {
      const response = await transports.workspaceBinaryTransport.execute(await parseJsonBody<unknown>(req));
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, UNAVAILABLE['/api/files/binary']);
    }
    return true;
  }

  if (url.pathname === '/api/files/list-dir' && req.method === 'POST') {
    const transports = getWorkspaceTransports(deps);
    if (!transports?.workspaceDirectoryTransport) {
      sendJson(res, 503, UNAVAILABLE['/api/files/list-dir']);
      return true;
    }
    try {
      const response = await transports.workspaceDirectoryTransport.list(await parseJsonBody<unknown>(req));
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, UNAVAILABLE['/api/files/list-dir']);
    }
    return true;
  }

  if (url.pathname === '/api/files/write-text' && req.method === 'POST') {
    const transports = getWorkspaceTransports(deps);
    if (!transports?.workspaceWriteTransport) {
      sendJson(res, 503, UNAVAILABLE['/api/files/write-text']);
      return true;
    }
    try {
      const response = await transports.workspaceWriteTransport.write(await parseJsonBody<unknown>(req));
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, UNAVAILABLE['/api/files/write-text']);
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
      if (body.filePath && (typeof body.filePath !== 'string' || !isOpaqueStagedAttachmentId(body.filePath))) {
        sendJson(res, 400, { success: false, error: 'Image source unavailable' });
        return true;
      }
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
      if (body.filePath) {
        await copyStagedAttachment(body.filePath, result.filePath);
      } else if (body.base64) {
        const fsP = await import('node:fs/promises');
        await fsP.writeFile(result.filePath, Buffer.from(body.base64, 'base64'));
      } else {
        sendJson(res, 400, { success: false, error: 'No image data provided' });
        return true;
      }
      sendJson(res, 200, { success: true, savedPath: basename(result.filePath.replaceAll('\\', '/')) });
    } catch {
      sendJson(res, 500, { success: false, error: 'Image save failed.' });
    }
    return true;
  }

  return false;
}

function getWorkspaceTransports(
  deps: FileApiContext | WorkspaceFileRouteDeps | undefined,
): WorkspaceFileRouteDeps | null {
  if (!deps || !isRecord(deps)) return null;
  return deps as WorkspaceFileRouteDeps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOpaqueStagedAttachmentId(value: string): boolean {
  return Boolean(value)
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes(':')
    && !value.includes('\0');
}
