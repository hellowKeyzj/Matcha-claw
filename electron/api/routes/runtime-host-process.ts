import type { IncomingMessage, ServerResponse } from 'http';
import type { RuntimeHostApiContext } from '../context';
import { RuntimeHostControlError } from '../../main/runtime-host-delivery/control';
import { RuntimeHostLifecycleUnavailableError } from '../../main/runtime-host-delivery/lifecycle-owner';
import { readRuntimeHostStatusProjection } from './app';
import { sendJson } from '../route-utils';

const RESTART_UNKNOWN = 'Runtime Host restart outcome is unknown';
const RESTART_FAILED = 'Runtime Host restart failed';

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
    try {
      await ctx.runtimeHost.restart();
      sendJson(res, 200, { success: true });
    } catch (error) {
      const unknown = error instanceof RuntimeHostControlError && error.delivery === 'unknown-delivery';
      sendJson(res, unknown ? 503 : 500, {
        success: false,
        error: unknown || error instanceof RuntimeHostLifecycleUnavailableError
          ? RESTART_UNKNOWN
          : RESTART_FAILED,
      });
    }
    return true;
  }

  return false;
}
