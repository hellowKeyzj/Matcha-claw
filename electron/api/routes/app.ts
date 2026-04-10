import type { IncomingMessage, ServerResponse } from 'http';
import type { AppApiContext } from '../context';

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
    // Send a current-state snapshot immediately so renderer subscribers do not
    // miss lifecycle transitions that happened before the SSE connection opened.
    res.write(`event: gateway:status\ndata: ${JSON.stringify(ctx.gatewayManager.getStatus())}\n\n`);
    return true;
  }

  return false;
}
