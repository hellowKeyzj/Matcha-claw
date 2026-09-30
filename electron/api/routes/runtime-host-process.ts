import type { IncomingMessage, ServerResponse } from 'http';
import type { RuntimeHostApiContext } from '../context';
import { readRuntimeHostStatusProjection } from './app';
import { sendJson } from '../route-utils';

export async function handleRuntimeHostProcessRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RuntimeHostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/runtime-host/status' && req.method === 'GET') {
    const status = await readRuntimeHostStatusProjection(ctx.runtimeHost);
    if (status) {
      sendJson(res, 200, status);
    } else {
      sendJson(res, 503, {
        status: 'error',
        hostLifecycle: 'ready',
        runtimeLifecycle: 'ready',
        updatedAt: Date.now(),
        error: 'Runtime Host status observation is unavailable.',
      });
    }
    return true;
  }

  if (url.pathname === '/api/runtime-host/restart' && req.method === 'POST') {
    const admission = ctx.runtimeHost.admitRestart();
    sendJson(res, admission.accepted ? 202 : 503, admission);
    return true;
  }

  if (url.pathname === '/api/runtime-host/restart' && req.method === 'GET') {
    const restartId = url.searchParams.get('restartId');
    if (!restartId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(restartId)) {
      sendJson(res, 400, { error: 'Invalid Runtime Host restart identity' });
      return true;
    }
    const restart = ctx.runtimeHost.readRestart(restartId);
    sendJson(res, restart ? 200 : 404, restart ?? { error: 'Runtime Host restart result is missing or expired' });
    return true;
  }

  return false;
}
