interface LocalDispatchResponse {
  status: number;
  data: unknown;
}
import { SessionsService } from '../../application/sessions/service';

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
  if (!(method === 'POST' && routePath === '/api/sessions/delete')) {
    return null;
  }
  const service = new SessionsService({
    getOpenClawConfigDir: deps.getOpenClawConfigDir,
    resolveDeletedPath: deps.resolveDeletedPath,
  });

  try {
    return await service.delete(payload);
  } catch (error) {
    return {
      status: 500,
      data: { success: false, error: String(error) },
    };
  }
}
