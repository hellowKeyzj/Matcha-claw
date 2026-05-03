interface LocalDispatchResponse {
  status: number;
  data: unknown;
}
import { SessionRuntimeService } from '../../application/session-runtime/service';
import type { OpenClawBridge } from '../../openclaw-bridge';

interface SessionRouteDeps {
  getOpenClawConfigDir: () => string;
  resolveDeletedPath: (path: string) => string;
  openclawBridge: Pick<OpenClawBridge, 'chatSend'>;
}

let cachedSessionRuntimeService: SessionRuntimeService | null = null;
let cachedSessionRuntimeConfigDir = '';
let cachedSessionRuntimeBridge: SessionRouteDeps['openclawBridge'] | null = null;

export function getSessionRuntimeService(
  deps: SessionRouteDeps,
): SessionRuntimeService {
  const configDir = deps.getOpenClawConfigDir();
  if (
    cachedSessionRuntimeService
    && cachedSessionRuntimeConfigDir === configDir
    && cachedSessionRuntimeBridge === deps.openclawBridge
  ) {
    return cachedSessionRuntimeService;
  }
  cachedSessionRuntimeService = new SessionRuntimeService({
    getOpenClawConfigDir: () => configDir,
    resolveDeletedPath: deps.resolveDeletedPath,
    openclawBridge: deps.openclawBridge,
  });
  cachedSessionRuntimeConfigDir = configDir;
  cachedSessionRuntimeBridge = deps.openclawBridge;
  return cachedSessionRuntimeService;
}

export async function handleSessionRoute(
  method: string,
  routePath: string,
  payload: unknown,
  deps: SessionRouteDeps,
): Promise<LocalDispatchResponse | null> {
  const sessionRuntimeService = getSessionRuntimeService(deps);

  if (method === 'GET' && routePath === '/api/sessions/list') {
    try {
      return await sessionRuntimeService.listSessions();
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/sessions/window') {
    try {
      return await sessionRuntimeService.getSessionWindow(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/session/new') {
    try {
      return await sessionRuntimeService.createSession(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/session/load') {
    try {
      return await sessionRuntimeService.loadSession(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/session/prompt') {
    try {
      return await sessionRuntimeService.promptSession(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/sessions/delete') {
    try {
      return await sessionRuntimeService.deleteSession(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/session/switch') {
    try {
      return await sessionRuntimeService.switchSession(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/session/resume') {
    try {
      return await sessionRuntimeService.resumeSession(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/session/state') {
    try {
      return await sessionRuntimeService.getSessionStateSnapshot(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  return null;
}
