import type { OpenClawBridge } from '../../openclaw-bridge';
import type { ParentShellAction, ParentTransportUpstreamPayload } from '../../api/dispatch/parent-transport';
import { channelUsesLoginSession } from './channel-activation-strategy';

type LocalDispatchResponse = {
  status: number;
  data: unknown;
};

export interface ChannelServiceDeps {
  readonly openclawBridge: Pick<
    OpenClawBridge,
    'channelsStatus' | 'channelsConnect' | 'channelsDisconnect' | 'channelsRequestQr'
  >;
  readonly listConfiguredChannels: () => Promise<unknown>;
  readonly validateChannelConfig: (channelType: string) => Promise<Record<string, unknown>>;
  readonly validateChannelCredentials: (channelType: string, config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly requestParentShellAction: (action: ParentShellAction, payload?: unknown) => Promise<ParentTransportUpstreamPayload>;
  readonly mapParentTransportResponse: (upstream: ParentTransportUpstreamPayload) => LocalDispatchResponse;
  readonly saveChannelConfig: (payload: unknown) => Promise<void>;
  readonly setChannelEnabled: (channelType: string, enabled: boolean) => Promise<void>;
  readonly getChannelFormValues: (channelType: string, accountId?: string) => Promise<unknown>;
  readonly deleteChannelConfig: (channelType: string) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class ChannelService {
  constructor(private readonly deps: ChannelServiceDeps) {}

  private async restartGateway(): Promise<LocalDispatchResponse> {
    const restartResponse = await this.deps.requestParentShellAction('gateway_restart');
    if (!restartResponse.success) {
      return {
        status: restartResponse.status,
        data: { success: false, error: restartResponse.error.message },
      };
    }
    return {
      status: restartResponse.status,
      data: { success: true },
    };
  }

  async snapshot() {
    return {
      success: true,
      snapshot: await this.deps.openclawBridge.channelsStatus(true),
    };
  }

  async configured() {
    return {
      success: true,
      channels: await this.deps.listConfiguredChannels(),
    };
  }

  async validateConfig(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    return {
      success: true,
      ...(await this.deps.validateChannelConfig(channelType)),
    };
  }

  async validateCredentials(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    const config = isRecord(body.config) ? body.config : {};
    return {
      success: true,
      ...(await this.deps.validateChannelCredentials(channelType, config)),
    };
  }

  async activate(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    if (!channelType) {
      return {
        status: 400,
        data: { success: false, error: 'channelType is required' },
      } satisfies LocalDispatchResponse;
    }

    if (!channelUsesLoginSession(channelType)) {
      await this.deps.saveChannelConfig(payload);
      return await this.restartGateway();
    }

    const shellResponse = await this.deps.requestParentShellAction('channel_session_start', {
      channelType,
      ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
      ...(isRecord(body.config) ? { config: body.config } : {}),
    });
    return this.deps.mapParentTransportResponse(shellResponse);
  }

  async cancelSession(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    if (!channelType) {
      return {
        status: 400,
        data: { success: false, error: 'channelType is required' },
      } satisfies LocalDispatchResponse;
    }
    if (!channelUsesLoginSession(channelType)) {
      return {
        status: 400,
        data: { success: false, error: `channel ${channelType} does not use login session` },
      } satisfies LocalDispatchResponse;
    }

    const shellResponse = await this.deps.requestParentShellAction('channel_session_cancel', {
      channelType,
    });
    return this.deps.mapParentTransportResponse(shellResponse);
  }

  async setEnabled(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    if (!channelType) {
      return {
        status: 400,
        data: { success: false, error: 'channelType is required' },
      } satisfies LocalDispatchResponse;
    }
    await this.deps.setChannelEnabled(channelType, body.enabled === true);
    return await this.restartGateway();
  }

  async connect(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelId = typeof body.channelId === 'string' ? body.channelId : '';
    if (!channelId) {
      return {
        status: 400,
        data: { success: false, error: 'channelId is required' },
      } satisfies LocalDispatchResponse;
    }
    await this.deps.openclawBridge.channelsConnect(channelId);
    return {
      status: 200,
      data: { success: true },
    } satisfies LocalDispatchResponse;
  }

  async disconnect(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelId = typeof body.channelId === 'string' ? body.channelId : '';
    if (!channelId) {
      return {
        status: 400,
        data: { success: false, error: 'channelId is required' },
      } satisfies LocalDispatchResponse;
    }
    await this.deps.openclawBridge.channelsDisconnect(channelId);
    return {
      status: 200,
      data: { success: true },
    } satisfies LocalDispatchResponse;
  }

  async requestQr(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    if (!channelType) {
      return {
        status: 400,
        data: { success: false, error: 'channelType is required' },
      } satisfies LocalDispatchResponse;
    }
    const result = await this.deps.openclawBridge.channelsRequestQr(channelType);
    return {
      status: 200,
      data: {
        success: true,
        qrCode: typeof result?.qrCode === 'string' ? result.qrCode : '',
        sessionId: typeof result?.sessionId === 'string' ? result.sessionId : '',
      },
    } satisfies LocalDispatchResponse;
  }

  async getConfigValues(channelType: string, accountId?: string) {
    return {
      success: true,
      values: await this.deps.getChannelFormValues(channelType, accountId),
    };
  }

  async deleteConfig(channelType: string) {
    await this.deps.deleteChannelConfig(channelType);
    return await this.restartGateway();
  }
}
