import type { IncomingMessage, ServerResponse } from 'http';
import type { MatchaAgentAppServerApiContext } from '../context';
import { sendJson } from '../route-utils';

export async function handleMatchaAgentAppServerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: MatchaAgentAppServerApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/matcha-agent/app-server/status' && req.method === 'GET') {
    const state = ctx.matchaAgentAppServerManager.getState();
    const port = state.port ?? ctx.matchaAgentAppServerManager.getEndpointSnapshot()?.port ?? null;

    sendJson(res, 200, {
      processState: state.lifecycle,
      port,
      pid: state.pid ?? null,
      ready: state.lifecycle === 'running',
      lastError: state.lastError ?? null,
      updatedAt: Date.now(),
    });
    return true;
  }

  if (url.pathname === '/api/matcha-agent/app-server/restart' && req.method === 'POST') {
    try {
      await ctx.matchaAgentAppServerManager.restart();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
