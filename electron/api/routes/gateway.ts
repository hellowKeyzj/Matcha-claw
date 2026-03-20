import type { IncomingMessage, ServerResponse } from 'http';
import { PORTS } from '../../utils/config';
import { getSetting } from '../../utils/store';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleGatewayRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/app/gateway-info' && req.method === 'GET') {
    const status = ctx.gatewayManager.getStatus();
    const token = await getSetting('gatewayToken');
    const port = status.port || PORTS.OPENCLAW_GATEWAY;
    sendJson(res, 200, {
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      token,
      port,
    });
    return true;
  }

  if (url.pathname === '/api/gateway/status' && req.method === 'GET') {
    const status = ctx.gatewayManager.getStatus();
    if (ctx.platformFacade) {
      const platformHealth = await ctx.platformFacade.runtimeHealth();
      sendJson(res, 200, { ...status, platformHealth });
      return true;
    }
    sendJson(res, 200, status);
    return true;
  }

  if (url.pathname === '/api/gateway/health' && req.method === 'GET') {
    if (ctx.platformFacade) {
      const health = await ctx.platformFacade.runtimeHealth();
      sendJson(res, 200, {
        ok: health.status === 'running',
        status: health.status,
        detail: health.detail,
      });
      return true;
    }
    const health = await ctx.gatewayManager.checkHealth();
    sendJson(res, 200, health);
    return true;
  }

  if (url.pathname === '/api/gateway/start' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.start();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/stop' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.stop();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/restart' && req.method === 'POST') {
    try {
      await ctx.gatewayManager.restart();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/gateway/control-ui' && req.method === 'GET') {
    try {
      const status = ctx.gatewayManager.getStatus();
      const token = await getSetting('gatewayToken');
      const port = status.port || PORTS.OPENCLAW_GATEWAY;
      const urlValue = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
      sendJson(res, 200, { success: true, url: urlValue, token, port });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/chat/send-with-media' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        sessionKey: string;
        message: string;
        deliver?: boolean;
        idempotencyKey: string;
        media?: Array<{ filePath: string; mimeType: string; fileName: string }>;
      }>(req);
      const VISION_MIME_TYPES = new Set([
        'image/png', 'image/jpeg', 'image/bmp', 'image/webp',
      ]);
      const imageAttachments: Array<{ content: string; mimeType: string; fileName: string }> = [];
      const fileReferences: string[] = [];
      if (body.media && body.media.length > 0) {
        const fsP = await import('node:fs/promises');
        for (const m of body.media) {
          fileReferences.push(`[media attached: ${m.filePath} (${m.mimeType}) | ${m.filePath}]`);
          if (VISION_MIME_TYPES.has(m.mimeType)) {
            const fileBuffer = await fsP.readFile(m.filePath);
            imageAttachments.push({
              content: fileBuffer.toString('base64'),
              mimeType: m.mimeType,
              fileName: m.fileName,
            });
          }
        }
      }

      const message = fileReferences.length > 0
        ? [body.message, ...fileReferences].filter(Boolean).join('\n')
        : body.message;
      const rpcParams: Record<string, unknown> = {
        sessionKey: body.sessionKey,
        message,
        deliver: body.deliver ?? false,
        idempotencyKey: body.idempotencyKey,
      };
      if (imageAttachments.length > 0) {
        rpcParams.attachments = imageAttachments;
      }
      const result = await ctx.gatewayManager.rpc('chat.send', rpcParams, 120000);
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/platform/runtime/health' && req.method === 'GET') {
    if (!ctx.platformFacade) {
      sendJson(res, 501, { success: false, error: 'platform facade unavailable' });
      return true;
    }
    const health = await ctx.platformFacade.runtimeHealth();
    sendJson(res, 200, {
      success: true,
      status: health.status,
      detail: health.detail,
      ok: health.status === 'running',
    });
    return true;
  }

  if (url.pathname === '/api/platform/tools/install-native' && req.method === 'POST') {
    if (!ctx.platformFacade) {
      sendJson(res, 501, { success: false, error: 'platform facade unavailable' });
      return true;
    }
    try {
      const body = await parseJsonBody<{ source?: { kind: string; spec: string; version?: string } }>(req);
      if (!body.source) {
        sendJson(res, 400, { success: false, error: 'source is required' });
        return true;
      }
      const toolId = await ctx.platformFacade.installNativeTool(body.source);
      sendJson(res, 200, { success: true, toolId });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/platform/tools/reconcile' && req.method === 'POST') {
    if (!ctx.platformFacade) {
      sendJson(res, 501, { success: false, error: 'platform facade unavailable' });
      return true;
    }
    try {
      const report = await ctx.platformFacade.reconcileNativeTools();
      sendJson(res, 200, { success: true, report });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/platform/tools' && req.method === 'GET') {
    if (!ctx.platformFacade) {
      sendJson(res, 501, { success: false, error: 'platform facade unavailable' });
      return true;
    }
    try {
      const includeDisabled = url.searchParams.get('includeDisabled') === 'true';
      const refresh = url.searchParams.get('refresh') !== 'false';

      if (refresh) {
        try {
          const health = await ctx.platformFacade.runtimeHealth();
          if (health.status === 'running') {
            await ctx.platformFacade.reconcileNativeTools();
          }
        } catch {
          // 运行时同步失败时，保持可读性，继续返回当前注册表快照
        }
      }

      let tools = await ctx.platformFacade.listEffectiveTools({ includeDisabled });

      sendJson(res, 200, { success: true, tools, refreshed: refresh });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
