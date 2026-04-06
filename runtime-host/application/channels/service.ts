import type { OpenClawBridge } from '../../openclaw-bridge';
import type { ParentShellAction, ParentTransportUpstreamPayload } from '../../api/dispatch/parent-transport';

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

  async startWhatsApp(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const shellResponse = await this.deps.requestParentShellAction('channel_whatsapp_start', {
      accountId: typeof body.accountId === 'string' ? body.accountId : '',
    });
    return this.deps.mapParentTransportResponse(shellResponse);
  }

  async cancelWhatsApp() {
    const shellResponse = await this.deps.requestParentShellAction('channel_whatsapp_cancel');
    return this.deps.mapParentTransportResponse(shellResponse);
  }

  async startWeixin(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const shellResponse = await this.deps.requestParentShellAction('channel_openclaw_weixin_start', {
      ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
      ...(isRecord(body.config) ? { config: body.config } : {}),
    });
    return this.deps.mapParentTransportResponse(shellResponse);
  }

  async cancelWeixin() {
    const shellResponse = await this.deps.requestParentShellAction('channel_openclaw_weixin_cancel');
    return this.deps.mapParentTransportResponse(shellResponse);
  }

  async saveConfig(payload: unknown) {
    await this.deps.saveChannelConfig(payload);
    return { success: true };
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
    return {
      status: 200,
      data: { success: true },
    } satisfies LocalDispatchResponse;
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
    return { success: true };
  }
}
