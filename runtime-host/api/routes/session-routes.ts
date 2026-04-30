interface LocalDispatchResponse {
  status: number;
  data: unknown;
}
import { SessionsService } from '../../application/sessions/service';
import { SessionCatalogService } from '../../application/sessions/catalog-service';
import { SessionWindowService } from '../../application/sessions/window-service';

interface SessionRouteDeps {
  getOpenClawConfigDir: () => string;
  resolveDeletedPath: (path: string) => string;
}

export async function handleSessionRoute(
  method: string,
  routePath: string,
  payload: unknown,
  deps: SessionRouteDeps,
): Promise<LocalDispatchResponse | null> {
  const sessionDeps = {
    getOpenClawConfigDir: deps.getOpenClawConfigDir,
  };
  const service = new SessionsService({
    ...sessionDeps,
    resolveDeletedPath: deps.resolveDeletedPath,
  });
  const catalogService = new SessionCatalogService(sessionDeps);
  const windowService = new SessionWindowService(sessionDeps);

  if (method === 'GET' && routePath === '/api/sessions/list') {
    try {
      return await catalogService.list();
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/sessions/window') {
    try {
      return await windowService.getWindow(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (!(method === 'POST' && routePath === '/api/sessions/delete')) {
    return null;
  }

  try {
    return await service.delete(payload);
  } catch (error) {
    return {
      status: 500,
      data: { success: false, error: String(error) },
    };
  }
}
