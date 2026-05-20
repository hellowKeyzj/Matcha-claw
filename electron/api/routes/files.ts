import type { IncomingMessage, ServerResponse } from 'http';
import { dialog } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { FileApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleFileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: FileApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/files/write-text' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        path?: string;
        content?: string;
      }>(req);
      const targetPath = typeof body.path === 'string' ? body.path.trim() : '';
      if (!targetPath) {
        sendJson(res, 400, { ok: false, error: 'path is required' });
        return true;
      }
      if (typeof body.content !== 'string') {
        sendJson(res, 400, { ok: false, error: 'content is required' });
        return true;
      }
      const fsP = await import('node:fs/promises');
      const resolvedPath = resolve(targetPath);
      await fsP.mkdir(dirname(resolvedPath), { recursive: true });
      await fsP.writeFile(resolvedPath, body.content, 'utf8');
      sendJson(res, 200, { ok: true, path: resolvedPath });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error) });
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
