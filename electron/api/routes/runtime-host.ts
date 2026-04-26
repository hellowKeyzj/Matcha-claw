import type { IncomingMessage, ServerResponse } from 'http';
import type { RuntimeHostApiContext } from '../context';
import { sendJson } from '../route-utils';

export async function handleRuntimeHostRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RuntimeHostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/plugins/runtime/restart' && req.method === 'POST') {
    try {
      await ctx.runtimeHost.restart();
      const result = await ctx.runtimeHost.request('GET', '/api/plugins/runtime');
      sendJson(res, result.status, result.data);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
