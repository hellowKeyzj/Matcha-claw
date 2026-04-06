import { PlatformService } from '../../application/platform-runtime/service';
import type { RuntimeHostPlatformFacade } from '../platform/runtime-root';

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

interface PlatformRouteDeps {
  readonly platformRuntime: RuntimeHostPlatformFacade;
}

export async function handlePlatformRoute(
  method: string,
  routePath: string,
  routeUrl: URL,
  payload: unknown,
  deps: PlatformRouteDeps,
): Promise<LocalDispatchResponse | null> {
  if (!(routePath === '/api/platform/runtime/health' || routePath.startsWith('/api/platform/'))) {
    return null;
  }
  const service = new PlatformService({
    platformRuntime: deps.platformRuntime,
  });

  if (method === 'GET' && routePath === '/api/platform/runtime/health') {
    return {
      status: 200,
      data: await service.runtimeHealth(),
    };
  }

  if (method === 'POST' && routePath === '/api/platform/runtime/start-run') {
    return {
      status: 200,
      data: await service.startRun(payload),
    };
  }

  if (method === 'POST' && routePath === '/api/platform/runtime/abort-run') {
    return await service.abortRun(payload);
  }

  if (method === 'POST' && routePath === '/api/platform/tools/install-native') {
    return await service.installNativeTool(payload);
  }

  if (method === 'POST' && routePath === '/api/platform/tools/reconcile') {
    return {
      status: 200,
      data: await service.reconcileTools(),
    };
  }

  if (method === 'GET' && routePath === '/api/platform/tools') {
    return {
      status: 200,
      data: await service.listTools(routeUrl),
    };
  }

  if (method === 'POST' && routePath === '/api/platform/tools/query') {
    return {
      status: 200,
      data: await service.queryTools(payload),
    };
  }

  if (method === 'POST' && routePath === '/api/platform/tools/upsert-platform') {
    return {
      status: 200,
      data: await service.upsertPlatformTools(payload),
    };
  }

  if (method === 'POST' && routePath === '/api/platform/tools/set-enabled') {
    return await service.setToolEnabled(payload);
  }

  if (method === 'POST' && routePath === '/api/platform/tools/execute') {
    return {
      status: 200,
      data: await service.executeTool(payload),
    };
  }

  return null;
}
