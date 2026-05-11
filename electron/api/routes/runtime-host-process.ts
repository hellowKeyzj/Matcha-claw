import type { IncomingMessage, ServerResponse } from 'http';
import type { RuntimeHostApiContext } from '../context';
import { sendJson } from '../route-utils';

export async function handleRuntimeHostProcessRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RuntimeHostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/runtime-host/restart' && req.method === 'POST') {
    try {
      await ctx.runtimeHost.restart();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
