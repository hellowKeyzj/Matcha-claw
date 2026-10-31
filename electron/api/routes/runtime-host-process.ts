import type { RuntimeHostApiContext } from '../context';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

export async function handleRuntimeHostProcessRoutes(
  req: HostApiRequest,
  url: URL,
  ctx: RuntimeHostApiContext,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/runtime-host/status' && req.method === 'GET') {
    const status = await ctx.runtimeStatus.readHost();
    if (status) {
      return jsonResult(200, status);
    } else {
      return jsonResult(503, {
        status: 'error',
        hostLifecycle: 'ready',
        runtimeLifecycle: 'ready',
        updatedAt: Date.now(),
        error: 'Runtime Host status observation is unavailable.',
      });
    }
  }

  if (url.pathname === '/api/runtime-host/restart' && req.method === 'POST') {
    const admission = ctx.runtimeHost.admitRestart();
    return jsonResult(admission.accepted ? 202 : 503, admission);
  }

  if (url.pathname === '/api/runtime-host/restart' && req.method === 'GET') {
    const restartId = url.searchParams.get('restartId');
    if (!restartId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(restartId)) {
      return jsonResult(400, { error: 'Invalid Runtime Host restart identity' });
    }
    const restart = ctx.runtimeHost.readRestart(restartId);
    return jsonResult(restart ? 200 : 404, restart ?? { error: 'Runtime Host restart result is missing or expired' });
  }

  return undefined;
}
