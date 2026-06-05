import type { RuntimeClockPort } from '../../common/runtime-ports';
import type { GatewayChannelPort } from '../../gateway/gateway-runtime-port';
import { isGatewayReadyForSnapshot } from '../../gateway/gateway-readiness';
import type { ChannelConfigPort } from '../../channels/channel-runtime';
import {
  projectChannelsSnapshot,
  type ProjectedChannelsSnapshot,
} from '../../channels/channel-snapshot-projection';

export interface ChannelRuntimeWorkflowDeps {
  readonly gateway: GatewayChannelPort;
  readonly channelConfig: Pick<ChannelConfigPort, 'listConfiguredChannels'>;
  readonly clock: RuntimeClockPort;
}

function resolveGatewayChannelId(channelType: string, accountId?: string): string {
  const normalizedAccountId = typeof accountId === 'string' ? accountId.trim() : '';
  return `${channelType}-${normalizedAccountId || 'default'}`;
}

export class ChannelRuntimeWorkflow {
  private gatewayChannelsCache: unknown = null;
  private gatewayChannelsCacheReady = false;
  private gatewayChannelsCacheError: string | null = null;
  private gatewayChannelsCacheUpdatedAt: number | null = null;

  constructor(private readonly deps: ChannelRuntimeWorkflowDeps) {}

  async snapshot() {
    if (await isGatewayReadyForSnapshot(this.deps.gateway)) {
      try {
        const refresh = await this.fetchAndCache(false);
        return {
          ...refresh,
          ready: true,
          refreshing: false,
          error: null,
        };
      } catch {
        const configuredChannels = await this.deps.channelConfig.listConfiguredChannels();
        return {
          success: true,
          snapshot: projectChannelsSnapshot(configuredChannels, this.gatewayChannelsCache),
          ready: true,
          refreshing: false,
          updatedAt: this.gatewayChannelsCacheUpdatedAt,
          error: this.gatewayChannelsCacheError,
        };
      }
    }

    const configuredChannels = await this.deps.channelConfig.listConfiguredChannels();
    const projected = projectChannelsSnapshot(configuredChannels, this.gatewayChannelsCache);

    return {
      success: true,
      snapshot: projected satisfies ProjectedChannelsSnapshot,
      ready: this.gatewayChannelsCacheReady,
      refreshing: false,
      updatedAt: this.gatewayChannelsCacheUpdatedAt,
      error: this.gatewayChannelsCacheError,
    };
  }

  async refreshSnapshot() {
    return await this.fetchAndCache(false);
  }

  async probeSnapshot() {
    return await this.fetchAndCache(true);
  }

  async connect(channelType: string, accountId?: string): Promise<{ success: true }> {
    await this.deps.gateway.channelsConnect(resolveGatewayChannelId(channelType, accountId));
    await this.refreshSnapshot();
    return { success: true };
  }

  async disconnect(channelType: string, accountId?: string): Promise<{ success: true }> {
    await this.deps.gateway.channelsDisconnect(resolveGatewayChannelId(channelType, accountId));
    await this.refreshSnapshot();
    return { success: true };
  }

  async requestQr(channelType: string): Promise<{ success: true; qrCode: string; sessionId: string }> {
    const result = await this.deps.gateway.channelsRequestQr(channelType);
    await this.refreshSnapshot();
    const qrResult = isRecord(result) ? result : {};
    return {
      success: true,
      qrCode: typeof qrResult.qrCode === 'string' ? qrResult.qrCode : '',
      sessionId: typeof qrResult.sessionId === 'string' ? qrResult.sessionId : '',
    };
  }

  private async fetchAndCache(probe: boolean) {
    try {
      this.gatewayChannelsCache = await this.deps.gateway.channelsStatus(probe);
      this.gatewayChannelsCacheReady = true;
      this.gatewayChannelsCacheError = null;
      this.gatewayChannelsCacheUpdatedAt = this.deps.clock.nowMs();
      const configuredChannels = await this.deps.channelConfig.listConfiguredChannels();
      return {
        success: true,
        snapshot: projectChannelsSnapshot(configuredChannels, this.gatewayChannelsCache),
        updatedAt: this.gatewayChannelsCacheUpdatedAt,
      };
    } catch (error) {
      this.gatewayChannelsCacheError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
