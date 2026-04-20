import type { OpenClawBridge } from '../../openclaw-bridge';
import type { ParentShellAction, ParentTransportUpstreamPayload } from '../dispatch/parent-transport';
import { ChannelService } from '../../application/channels/service';

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

interface ChannelRouteDeps {
  openclawBridge: Pick<
    OpenClawBridge,
    'channelsStatus' | 'channelsConnect' | 'channelsDisconnect' | 'channelsRequestQr'
  >;
  listConfiguredChannelsLocal: () => Promise<unknown>;
  validateChannelConfigLocal: (channelType: string) => Promise<Record<string, unknown>>;
  validateChannelCredentialsLocal: (channelType: string, config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  requestParentShellAction: (action: ParentShellAction, payload?: unknown) => Promise<ParentTransportUpstreamPayload>;
  mapParentTransportResponse: (upstream: ParentTransportUpstreamPayload) => LocalDispatchResponse;
  saveChannelConfigLocal: (payload: unknown) => Promise<void>;
  setChannelEnabledLocal: (channelType: string, enabled: boolean) => Promise<void>;
  getChannelFormValuesLocal: (channelType: string, accountId?: string) => Promise<unknown>;
  deleteChannelConfigLocal: (channelType: string) => Promise<void>;
}

export async function handleChannelRoute(
  method: string,
  routePath: string,
  routeUrl: URL,
  payload: unknown,
  deps: ChannelRouteDeps,
): Promise<LocalDispatchResponse | null> {
  if (!routePath.startsWith('/api/channels/')) {
    return null;
  }
  const service = new ChannelService({
    openclawBridge: deps.openclawBridge,
    listConfiguredChannels: deps.listConfiguredChannelsLocal,
    validateChannelConfig: deps.validateChannelConfigLocal,
    validateChannelCredentials: deps.validateChannelCredentialsLocal,
    requestParentShellAction: deps.requestParentShellAction,
    mapParentTransportResponse: deps.mapParentTransportResponse,
    saveChannelConfig: deps.saveChannelConfigLocal,
    setChannelEnabled: deps.setChannelEnabledLocal,
    getChannelFormValues: deps.getChannelFormValuesLocal,
    deleteChannelConfig: deps.deleteChannelConfigLocal,
  });

  if (method === 'GET' && routePath === '/api/channels/snapshot') {
    try {
      return {
        status: 200,
        data: await service.snapshot(),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'GET' && routePath === '/api/channels/configured') {
    try {
      return {
        status: 200,
        data: await service.configured(),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/channels/config/validate') {
    try {
      return {
        status: 200,
        data: await service.validateConfig(payload),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, valid: false, errors: [String(error)], warnings: [] },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/channels/credentials/validate') {
    try {
      return {
        status: 200,
        data: await service.validateCredentials(payload),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, valid: false, errors: [String(error)], warnings: [] },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/channels/activate') {
    try {
      return await service.activate(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/channels/session/cancel') {
    try {
      return await service.cancelSession(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'PUT' && routePath === '/api/channels/config/enabled') {
    try {
      return await service.setEnabled(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/channels/connect') {
    try {
      return await service.connect(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/channels/disconnect') {
    try {
      return await service.disconnect(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/channels/request-qr') {
    try {
      return await service.requestQr(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'GET' && routePath.startsWith('/api/channels/config/')) {
    try {
      const channelType = decodeURIComponent(routePath.slice('/api/channels/config/'.length));
      const accountId = routeUrl.searchParams.get('accountId') || undefined;
      return {
        status: 200,
        data: await service.getConfigValues(channelType, accountId),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'DELETE' && routePath.startsWith('/api/channels/config/')) {
    try {
      const channelType = decodeURIComponent(routePath.slice('/api/channels/config/'.length));
      return await service.deleteConfig(channelType);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  return null;
}
