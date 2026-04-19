import { SettingsService } from '../../application/settings/service';
import {
  normalizeBrowserMode,
  type BrowserMode,
} from '../../application/openclaw/openclaw-provider-config-service';

interface SettingsRouteDeps {
  getAllSettingsLocal: () => Promise<Record<string, unknown>>;
  setSettingsPatchLocal: (patch: Record<string, unknown>) => Promise<unknown>;
  resetSettingsLocal: () => Promise<Record<string, unknown>>;
  setSettingValueLocal: (key: string, value: unknown) => Promise<unknown>;
  syncProxyConfigToOpenClaw?: (
    settings: {
      proxyEnabled: boolean;
      proxyServer: string;
      proxyBypassRules: string;
    },
    options?: {
      preserveExistingWhenDisabled?: boolean;
    },
  ) => Promise<void>;
  syncBrowserModeToOpenClaw?: (mode: BrowserMode) => Promise<void>;
  requestParentShellAction?: (action: 'gateway_restart', payload?: unknown) => Promise<{
    success: boolean;
    status: number;
    data?: unknown;
    error?: { code: string; message: string };
  }>;
}

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExplicitProxyPatch(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(payload, 'proxyEnabled')
    || Object.prototype.hasOwnProperty.call(payload, 'proxyServer')
    || Object.prototype.hasOwnProperty.call(payload, 'proxyBypassRules');
}

function hasExplicitBrowserModePatch(payload: unknown): boolean {
  return isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, 'browserMode');
}

function toProxySettings(settings: Record<string, unknown>): {
  proxyEnabled: boolean;
  proxyServer: string;
  proxyBypassRules: string;
} {
  return {
    proxyEnabled: settings.proxyEnabled === true,
    proxyServer: typeof settings.proxyServer === 'string' ? settings.proxyServer : '',
    proxyBypassRules: typeof settings.proxyBypassRules === 'string' ? settings.proxyBypassRules : '',
  };
}

function toBrowserMode(settings: Record<string, unknown>): BrowserMode {
  return normalizeBrowserMode(settings.browserMode);
}

export async function handleSettingsRoute(
  method: string,
  routePath: string,
  payload: unknown,
  deps: SettingsRouteDeps,
): Promise<LocalDispatchResponse | null> {
  const service = new SettingsService({
    getAllSettings: deps.getAllSettingsLocal,
    setSettingsPatch: deps.setSettingsPatchLocal,
    resetSettings: deps.resetSettingsLocal,
    setSettingValue: deps.setSettingValueLocal,
  });

  if (routePath === '/api/settings' && method === 'GET') {
    return {
      status: 200,
      data: await service.getAll(),
    };
  }

  if (routePath === '/api/settings' && method === 'PUT') {
    try {
      const shouldSyncProxy = hasExplicitProxyPatch(payload);
      const shouldSyncBrowserMode = hasExplicitBrowserModePatch(payload);
      const patchResult = await service.patch(payload);
      const latestSettings = shouldSyncProxy || shouldSyncBrowserMode
        ? await service.getAll()
        : null;
      if (shouldSyncProxy && deps.syncProxyConfigToOpenClaw) {
        await deps.syncProxyConfigToOpenClaw(
          toProxySettings(latestSettings ?? {}),
          { preserveExistingWhenDisabled: false },
        );
      }
      if (shouldSyncBrowserMode && deps.syncBrowserModeToOpenClaw) {
        await deps.syncBrowserModeToOpenClaw(toBrowserMode(latestSettings ?? {}));
        if (deps.requestParentShellAction) {
          const restartResponse = await deps.requestParentShellAction('gateway_restart');
          if (!restartResponse.success) {
            return {
              status: restartResponse.status,
              data: { success: false, error: restartResponse.error?.message ?? 'gateway restart failed' },
            };
          }
        }
      }
      return {
        status: 200,
        data: patchResult,
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (routePath === '/api/settings/reset' && method === 'POST') {
    try {
      return {
        status: 200,
        data: await service.reset(),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (routePath.startsWith('/api/settings/')) {
    const key = decodeURIComponent(routePath.slice('/api/settings/'.length));
    if (!key) {
      return {
        status: 400,
        data: { success: false, error: 'settings key is required' },
      };
    }
    if (method === 'GET') {
      try {
        return {
          status: 200,
          data: await service.getValue(key),
        };
      } catch (error) {
        return {
          status: 500,
          data: { success: false, error: String(error) },
        };
      }
    }
    if (method === 'PUT') {
      try {
        const response = {
          status: 200,
          data: await service.setValue(key, payload),
        };
        if (key === 'browserMode' && deps.syncBrowserModeToOpenClaw) {
          const latestSettings = await service.getAll();
          await deps.syncBrowserModeToOpenClaw(toBrowserMode(latestSettings));
          if (deps.requestParentShellAction) {
            const restartResponse = await deps.requestParentShellAction('gateway_restart');
            if (!restartResponse.success) {
              return {
                status: restartResponse.status,
                data: { success: false, error: restartResponse.error?.message ?? 'gateway restart failed' },
              };
            }
          }
        }
        return response;
      } catch (error) {
        return {
          status: 500,
          data: { success: false, error: String(error) },
        };
      }
    }
  }

  return null;
}
