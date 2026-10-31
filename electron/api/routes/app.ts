import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppApiContext } from '../context';
import { getResourcesDir } from '../../utils/paths';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

export async function handleMainAppRoutes(
  req: HostApiRequest,
  url: URL,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/app/browser-relay-info' && req.method === 'GET') {
    const relativeDir = 'resources/tools/data/extension/chrome-extension/browser-relay';
    const extensionDir = join(
      getResourcesDir(),
      'tools',
      'data',
      'extension',
      'chrome-extension',
      'browser-relay',
    );

    return jsonResult(200, {
      relativeDir,
      extensionDir,
      exists: existsSync(extensionDir),
      chromeExtensionsUrl: 'chrome://extensions/',
    });
  }

  return undefined;
}

export async function handleAppRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: AppApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    ctx.eventBus.addSseClient(res);
    const status = await ctx.runtimeStatus.readBundle();
    // Send current-state snapshots immediately so renderer subscribers do not
    // miss lifecycle transitions that happened before the SSE connection opened.
    res.write(`event: gateway:status\ndata: ${JSON.stringify(status.gatewayStatus)}\n\n`);
    if (status.runtimeHostStatus) {
      res.write(`event: runtime-host:status\ndata: ${JSON.stringify(status.runtimeHostStatus)}\n\n`);
    }
    return true;
  }

  return false;
}
