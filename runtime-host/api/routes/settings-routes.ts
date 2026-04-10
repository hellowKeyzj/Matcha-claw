import { SettingsService } from '../../application/settings/service';

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
      const patchResult = await service.patch(payload);
      if (shouldSyncProxy && deps.syncProxyConfigToOpenClaw) {
        const latestSettings = await service.getAll();
        await deps.syncProxyConfigToOpenClaw(
          toProxySettings(latestSettings),
          { preserveExistingWhenDisabled: false },
        );
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
        return {
          status: 200,
          data: await service.setValue(key, payload),
        };
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
