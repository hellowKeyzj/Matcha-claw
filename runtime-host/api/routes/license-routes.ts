import type { ParentShellAction, ParentTransportUpstreamPayload } from '../dispatch/parent-transport';
import { LicenseService } from '../../application/license/service';

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

interface LicenseRouteDeps {
  requestParentShellAction: (action: ParentShellAction, payload?: unknown) => Promise<ParentTransportUpstreamPayload>;
  mapParentTransportResponse: (upstream: ParentTransportUpstreamPayload) => LocalDispatchResponse;
}

export async function handleLicenseRoute(
  method: string,
  routePath: string,
  payload: unknown,
  deps: LicenseRouteDeps,
): Promise<LocalDispatchResponse | null> {
  if (!routePath.startsWith('/api/license/')) {
    return null;
  }
  const service = new LicenseService({
    requestParentShellAction: deps.requestParentShellAction,
    mapParentTransportResponse: deps.mapParentTransportResponse,
  });

  if (method === 'GET' && routePath === '/api/license/gate') {
    try {
      return await service.gate();
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'GET' && routePath === '/api/license/stored-key') {
    try {
      return await service.storedKey();
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/license/validate') {
    try {
      return await service.validate(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/license/revalidate') {
    try {
      return await service.revalidate();
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/license/clear') {
    try {
      return await service.clear();
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  return null;
}
