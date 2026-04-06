import { TaskPluginService } from '../../application/task-plugin/service';

async function handleTaskPluginRouteLocal(
  method,
  routePath,
  deps?: {
    refreshPluginCatalog?: () => Promise<void>;
  },
) {
  const service = new TaskPluginService(deps);
  if (method === 'POST' && routePath === '/api/task-plugin/status') {
    return {
      status: 200,
      data: await service.status(),
    };
  }
  if (method === 'POST' && routePath === '/api/task-plugin/install') {
    return {
      status: 200,
      data: await service.install(),
    };
  }
  if (method === 'POST' && routePath === '/api/task-plugin/uninstall') {
    return {
      status: 200,
      data: await service.uninstall(),
    };
  }
  return null;
}

export { handleTaskPluginRouteLocal as handleTaskPluginRoute };
