import { dialog } from 'electron';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { copyStagedAttachment } from '../../main/attachments/staging';
import type { FileApiContext } from '../context';
import type { WorkspaceBinaryTransport } from '../../main/runtime-host-delivery/transport/workspace/read-binary';
import type { WorkspaceDirectoryTransport } from '../../main/runtime-host-delivery/transport/workspace/read-directory';
import type { WorkspaceTextTransport } from '../../main/runtime-host-delivery/transport/workspace/read-text';
import type { WorkspaceWriteTransport } from '../../main/runtime-host-delivery/transport/workspace/write-text';
import type { WorkspaceWriteBinaryTransport } from '../../main/runtime-host-delivery/transport/workspace/write-binary';
import { HostApiBodyTooLarge, jsonResult, parseJsonBytes, type HostApiRequest, type HostApiRouteResult } from '../execution';

export type WorkspaceFileRouteDeps = Readonly<{
  workspaceTextTransport?: WorkspaceTextTransport;
  workspaceBinaryTransport?: WorkspaceBinaryTransport;
  workspaceDirectoryTransport?: WorkspaceDirectoryTransport;
  workspaceWriteTransport?: WorkspaceWriteTransport;
  workspaceWriteBinaryTransport?: WorkspaceWriteBinaryTransport;
}>;

const UNAVAILABLE = {
  '/api/files/read-text': { success: false, error: 'Workspace text is unavailable' },
  '/api/files/binary': { success: false, error: 'Workspace binary is unavailable' },
  '/api/files/list-dir': { success: false, error: 'Workspace directory is unavailable' },
  '/api/files/write-text': { success: false, error: 'Workspace write is unavailable' },
  '/api/files/write-binary': { success: false, error: 'Workspace write is unavailable' },
} as const;

export async function handleFileRoutes(
  req: HostApiRequest,
  url: URL,
  deps?: FileApiContext | WorkspaceFileRouteDeps,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/files/read-text' && req.method === 'POST') {
    const transports = getWorkspaceTransports(deps);
    if (!transports?.workspaceTextTransport) {
      return jsonResult(503, UNAVAILABLE['/api/files/read-text']);
    }
    try {
      const response = await transports.workspaceTextTransport.read(await req.readJson<unknown>());
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, UNAVAILABLE['/api/files/read-text']);
    }
  }

  if (url.pathname === '/api/files/binary' && req.method === 'POST') {
    const transports = getWorkspaceTransports(deps);
    if (!transports?.workspaceBinaryTransport) {
      return jsonResult(503, UNAVAILABLE['/api/files/binary']);
    }
    try {
      const response = await transports.workspaceBinaryTransport.execute(await req.readJson<unknown>());
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, UNAVAILABLE['/api/files/binary']);
    }
  }

  if (url.pathname === '/api/files/list-dir' && req.method === 'POST') {
    const transports = getWorkspaceTransports(deps);
    if (!transports?.workspaceDirectoryTransport) {
      return jsonResult(503, UNAVAILABLE['/api/files/list-dir']);
    }
    try {
      const response = await transports.workspaceDirectoryTransport.list(await req.readJson<unknown>());
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, UNAVAILABLE['/api/files/list-dir']);
    }
  }

  if (url.pathname === '/api/files/write-text' && req.method === 'POST') {
    const transports = getWorkspaceTransports(deps);
    if (!transports?.workspaceWriteTransport) {
      return jsonResult(503, UNAVAILABLE['/api/files/write-text']);
    }
    try {
      const response = await transports.workspaceWriteTransport.write(await req.readJson<unknown>());
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, UNAVAILABLE['/api/files/write-text']);
    }
  }

  if (url.pathname === '/api/files/write-binary' && req.method === 'POST') {
    const transports = getWorkspaceTransports(deps);
    if (!transports?.workspaceWriteBinaryTransport) {
      return jsonResult(503, UNAVAILABLE['/api/files/write-binary']);
    }
    let request: unknown;
    try {
      request = parseJsonBytes(await req.readBytes(70 * 1024 * 1024, true));
    } catch (error) {
      if (error instanceof HostApiBodyTooLarge) {
        return jsonResult(413, { success: false, error: 'Workspace write content exceeds the limit' });
      }
      return jsonResult(503, UNAVAILABLE['/api/files/write-binary']);
    }
    try {
      const response = await transports.workspaceWriteBinaryTransport.write(request);
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(422, { success: false, error: 'Workspace write outcome is unknown' });
    }
  }

  if (url.pathname === '/api/files/save-image' && req.method === 'POST') {
    try {
      const body = await req.readJson<{
        base64?: string;
        mimeType?: string;
        filePath?: string;
        defaultFileName: string;
      }>();
      if (body.filePath && (typeof body.filePath !== 'string' || !isOpaqueStagedAttachmentId(body.filePath))) {
        return jsonResult(400, { success: false, error: 'Image source unavailable' });
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
        return jsonResult(200, { success: false });
      }
      if (body.filePath) {
        await copyStagedAttachment(body.filePath, result.filePath);
      } else if (body.base64) {
        const fsP = await import('node:fs/promises');
        await fsP.writeFile(result.filePath, Buffer.from(body.base64, 'base64'));
      } else {
        return jsonResult(400, { success: false, error: 'No image data provided' });
      }
      return jsonResult(200, { success: true, savedPath: basename(result.filePath.replaceAll('\\', '/')) });
    } catch {
      return jsonResult(500, { success: false, error: 'Image save failed.' });
    }
  }

  return undefined;
}

function getWorkspaceTransports(
  deps: FileApiContext | WorkspaceFileRouteDeps | undefined,
): WorkspaceFileRouteDeps | null {
  if (!deps || !isRecord(deps)) return null;
  if ('runtimeHostTransports' in deps) return deps.runtimeHostTransports;
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
