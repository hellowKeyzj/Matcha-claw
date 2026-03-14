import { BrowserWindow, ipcMain } from 'electron';
import { GatewayManager } from '../../../gateway/manager';
import { getSetting } from '../../../utils/store';
import { proxyAwareFetch } from '../../../utils/proxy-fetch';
import { logger } from '../../../utils/logger';
import type { PlatformRuntimeFacade } from '../../../main/platform-ipc-facade';
import type { AssembleRequest, RegistryQuery, ToolSource } from '../../../core/contracts';

export function registerGatewayHandlers(
  gatewayManager: GatewayManager,
  mainWindow: BrowserWindow,
  platformFacade?: PlatformRuntimeFacade,
): void {
  type GatewayHttpProxyRequest = {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  };

  // Get Gateway status
  ipcMain.handle('gateway:status', async () => {
    const gatewayStatus = gatewayManager.getStatus();
    if (!platformFacade) {
      return gatewayStatus;
    }
    const runtimeHealth = await platformFacade.runtimeHealth();
    return {
      ...gatewayStatus,
      platformHealth: runtimeHealth,
    };
  });

  // Check if Gateway is connected
  ipcMain.handle('gateway:isConnected', () => {
    return gatewayManager.isConnected();
  });

  // Start Gateway
  ipcMain.handle('gateway:start', async () => {
    try {
      await gatewayManager.start();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Stop Gateway
  ipcMain.handle('gateway:stop', async () => {
    try {
      await gatewayManager.stop();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Restart Gateway
  ipcMain.handle('gateway:restart', async () => {
    try {
      await gatewayManager.restart();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Gateway RPC call
  ipcMain.handle('gateway:rpc', async (_, method: string, params?: unknown, timeoutMs?: number) => {
    try {
      const result = await gatewayManager.rpc(method, params, timeoutMs);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('platform:runtimeHealth', async () => {
    if (!platformFacade) {
      return { success: false, error: 'platform facade unavailable' };
    }
    try {
      const status = await platformFacade.runtimeHealth();
      return { success: true, status };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('platform:installNativeTool', async (_, source: ToolSource) => {
    if (!platformFacade) {
      return { success: false, error: 'platform facade unavailable' };
    }
    try {
      const toolId = await platformFacade.installNativeTool(source);
      return { success: true, toolId };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('platform:reconcileTools', async () => {
    if (!platformFacade) {
      return { success: false, error: 'platform facade unavailable' };
    }
    try {
      const report = await platformFacade.reconcileNativeTools();
      return { success: true, report };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('platform:startRun', async (_, req: AssembleRequest) => {
    if (!platformFacade) {
      return { success: false, error: 'platform facade unavailable' };
    }
    try {
      const runId = await platformFacade.startRun(req);
      return { success: true, runId };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('platform:abortRun', async (_, runId: string) => {
    if (!platformFacade) {
      return { success: false, error: 'platform facade unavailable' };
    }
    try {
      await platformFacade.abortRun(runId);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('platform:listTools', async (_, query?: RegistryQuery) => {
    if (!platformFacade) {
      return { success: false, error: 'platform facade unavailable' };
    }
    try {
      const tools = await platformFacade.listEffectiveTools(query);
      return { success: true, tools };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Gateway HTTP proxy
  // Renderer must not call gateway HTTP directly (CORS); all HTTP traffic
  // should go through this main-process proxy.
  ipcMain.handle('gateway:httpProxy', async (_, request: GatewayHttpProxyRequest) => {
    try {
      const status = gatewayManager.getStatus();
      const port = status.port || 18789;
      const path = request?.path && request.path.startsWith('/') ? request.path : '/';
      const method = (request?.method || 'GET').toUpperCase();
      const timeoutMs =
        typeof request?.timeoutMs === 'number' && request.timeoutMs > 0
          ? request.timeoutMs
          : 15000;

      const token = await getSetting('gatewayToken');
      const headers: Record<string, string> = {
        ...(request?.headers ?? {}),
      };
      if (!headers.Authorization && !headers.authorization && token) {
        headers.Authorization = `Bearer ${token}`;
      }

      let body: string | undefined;
      if (request?.body !== undefined && request?.body !== null) {
        body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await proxyAwareFetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const json = await response.json();
        return {
          success: true,
          status: response.status,
          ok: response.ok,
          json,
        };
      }

      const text = await response.text();
      return {
        success: true,
        status: response.status,
        ok: response.ok,
        text,
      };
    } catch (error) {
      return {
        success: false,
        error: String(error),
      };
    }
  });

  // Chat send with media — reads staged files from disk and builds attachments.
  // Raster images (png/jpg/gif/webp) are inlined as base64 vision attachments.
  // All other files are referenced by path in the message text so the model
  // can access them via tools (the same format channels use).
  const VISION_MIME_TYPES = new Set([
    'image/png', 'image/jpeg', 'image/bmp', 'image/webp',
  ]);

  ipcMain.handle('chat:sendWithMedia', async (_, params: {
    sessionKey: string;
    message: string;
    deliver?: boolean;
    idempotencyKey: string;
    media?: Array<{ filePath: string; mimeType: string; fileName: string }>;
  }) => {
    try {
      let message = params.message;
      // The Gateway processes image attachments through TWO parallel paths:
      // Path A: `attachments` param → parsed via `parseMessageWithAttachments` →
      //   injected as inline vision content when the model supports images.
      //   Format: { content: base64, mimeType: string, fileName?: string }
      // Path B: `[media attached: ...]` in message text → Gateway's native image
      //   detection (`detectAndLoadPromptImages`) reads the file from disk and
      //   injects it as inline vision content. Also works for history messages.
      // We use BOTH paths for maximum reliability.
      const imageAttachments: Array<Record<string, unknown>> = [];
      const fileReferences: string[] = [];

      if (params.media && params.media.length > 0) {
        const fsP = await import('fs/promises');
        for (const m of params.media) {
          const exists = await fsP.access(m.filePath).then(() => true, () => false);
          logger.info(`[chat:sendWithMedia] Processing file: ${m.fileName} (${m.mimeType}), path: ${m.filePath}, exists: ${exists}, isVision: ${VISION_MIME_TYPES.has(m.mimeType)}`);

          // Always add file path reference so the model can access it via tools
          fileReferences.push(
            `[media attached: ${m.filePath} (${m.mimeType}) | ${m.filePath}]`,
          );

          if (VISION_MIME_TYPES.has(m.mimeType)) {
            // Send as base64 attachment in the format the Gateway expects:
            // { content: base64String, mimeType: string, fileName?: string }
            // The Gateway normalizer looks for `a.content` (NOT `a.source.data`).
            const fileBuffer = await fsP.readFile(m.filePath);
            const base64Data = fileBuffer.toString('base64');
            logger.info(`[chat:sendWithMedia] Read ${fileBuffer.length} bytes, base64 length: ${base64Data.length}`);
            imageAttachments.push({
              content: base64Data,
              mimeType: m.mimeType,
              fileName: m.fileName,
            });
          }
        }
      }

      // Append file references to message text so the model knows about them
      if (fileReferences.length > 0) {
        const refs = fileReferences.join('\n');
        message = message ? `${message}\n\n${refs}` : refs;
      }

      const rpcParams: Record<string, unknown> = {
        sessionKey: params.sessionKey,
        message,
        deliver: params.deliver ?? false,
        idempotencyKey: params.idempotencyKey,
      };

      if (imageAttachments.length > 0) {
        rpcParams.attachments = imageAttachments;
      }

      logger.info(`[chat:sendWithMedia] Sending: message="${message.substring(0, 100)}", attachments=${imageAttachments.length}, fileRefs=${fileReferences.length}`);

      // Longer timeout for chat sends to tolerate high-latency networks (avoids connect error)
      const timeoutMs = 120000;
      const result = await gatewayManager.rpc('chat.send', rpcParams, timeoutMs);
      logger.info(`[chat:sendWithMedia] RPC result: ${JSON.stringify(result)}`);
      return { success: true, result };
    } catch (error) {
      logger.error(`[chat:sendWithMedia] Error: ${String(error)}`);
      return { success: false, error: String(error) };
    }
  });

  // Get the Control UI URL with token for embedding
  ipcMain.handle('gateway:getControlUiUrl', async () => {
    try {
      const status = gatewayManager.getStatus();
      const token = await getSetting('gatewayToken');
      const port = status.port || 18789;
      // Pass token as query param - Control UI will store it in localStorage
      const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
      return { success: true, url, port, token };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Health check
  ipcMain.handle('gateway:health', async () => {
    try {
      if (platformFacade) {
        const health = await platformFacade.runtimeHealth();
        return {
          success: true,
          ok: health.status === 'running',
          status: health.status,
          detail: health.detail,
        };
      }
      const health = await gatewayManager.checkHealth();
      return { success: true, ...health };
    } catch (error) {
      return { success: false, ok: false, error: String(error) };
    }
  });

  // Forward Gateway events to renderer
  gatewayManager.on('status', (status) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:status-changed', status);
    }
  });

  gatewayManager.on('message', (message) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:message', message);
    }
  });

  gatewayManager.on('notification', (notification) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:notification', notification);
    }
  });

  gatewayManager.on('channel:status', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:channel-status', data);
    }
  });

  gatewayManager.on('chat:message', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:chat-message', data);
    }
  });

  gatewayManager.on('exit', (code) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:exit', code);
    }
  });

  gatewayManager.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:error', error.message);
    }
  });
}
