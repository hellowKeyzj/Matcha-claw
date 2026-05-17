import {
  accepted,
  badRequest,
  ok,
} from '../common/application-response';
import type { RuntimeClockPort } from '../common/runtime-ports';
import type { GatewayChannelPort } from '../gateway/gateway-runtime-port';
import { isGatewayReadyForSnapshot } from '../gateway/gateway-readiness';
import type { ParentShellPort } from '../runtime-host/parent-shell-port';
import { channelUsesLoginSession } from './channel-activation-strategy';
import type { ChannelJobPort } from './channel-jobs';
import type { ChannelPairingService } from './channel-pairing-service';
import type { ChannelConfigPort } from './channel-runtime';
import type { ChannelLoginSessionService } from './channel-login-session-service';
import {
  projectChannelsSnapshot,
  type ProjectedChannelsSnapshot,
} from './channel-snapshot-projection';

export interface ChannelServiceDeps {
  readonly gateway: GatewayChannelPort;
  readonly channelConfig: ChannelConfigPort;
  readonly parentShell: ParentShellPort;
  readonly loginSessions: Pick<ChannelLoginSessionService, 'start' | 'cancel'>;
  readonly pairing: Pick<ChannelPairingService, 'listRequests' | 'approveRequest'>;
  readonly jobs: ChannelJobPort;
  readonly clock: RuntimeClockPort;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class ChannelService {
  private gatewayChannelsCache: unknown = null;
  private gatewayChannelsCacheReady = false;
  private gatewayChannelsCacheError: string | null = null;
  private gatewayChannelsCacheUpdatedAt: number | null = null;
  private snapshotRefreshTask: Promise<unknown> | null = null;

  constructor(private readonly deps: ChannelServiceDeps) {}

  private async restartGateway(): Promise<void> {
    const restartResponse = await this.deps.parentShell.request('gateway_restart');
    if (!restartResponse.success) {
      throw new Error(restartResponse.error?.message ?? 'gateway restart failed');
    }
  }

  async activateDirect(payload: unknown): Promise<{ success: true }> {
    await this.deps.channelConfig.saveChannelConfig(payload);
    await this.restartGateway();
    return { success: true };
  }

  async deleteConfigDirect(channelType: string): Promise<{ success: true }> {
    await this.deps.channelConfig.deleteChannelConfig(channelType);
    await this.restartGateway();
    return { success: true };
  }

  async snapshot() {
    const configuredChannels = await this.deps.channelConfig.listConfiguredChannels();
    const projected = projectChannelsSnapshot(configuredChannels, this.gatewayChannelsCache);

    let refreshSubmitted = false;
    if (await isGatewayReadyForSnapshot(this.deps.gateway)) {
      this.deps.jobs.submitRefreshSnapshot();
      refreshSubmitted = true;
    }

    return {
      success: true,
      snapshot: projected satisfies ProjectedChannelsSnapshot,
      ready: this.gatewayChannelsCacheReady,
      refreshing: refreshSubmitted || this.snapshotRefreshTask !== null,
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

  async validateConfig(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    return {
      success: true,
      ...(await this.deps.channelConfig.validateChannelConfig(channelType)),
    };
  }

  async validateCredentials(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    const config = isRecord(body.config) ? body.config : {};
    return {
      success: true,
      ...(await this.deps.channelConfig.validateChannelCredentials(channelType, config)),
    };
  }

  async activate(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    if (!channelType) {
      return badRequest('channelType is required');
    }

    if (!channelUsesLoginSession(channelType)) {
      return accepted(this.deps.jobs.submitActivateDirectChannel(payload));
    }

    await this.deps.channelConfig.prepareChannelPlugin(channelType);
    const result = await this.deps.loginSessions.start({
      channelType,
      ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
      ...(isRecord(body.config) ? { config: body.config } : {}),
    });
    return ok({ success: true, ...result });
  }

  async cancelSession(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    if (!channelType) {
      return badRequest('channelType is required');
    }
    if (!channelUsesLoginSession(channelType)) {
      return badRequest(`channel ${channelType} does not use login session`);
    }

    await this.deps.loginSessions.cancel(channelType);
    return ok({ success: true });
  }

  async connect(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelId = typeof body.channelId === 'string' ? body.channelId : '';
    if (!channelId) {
      return badRequest('channelId is required');
    }
    await this.deps.gateway.channelsConnect(channelId);
    await this.refreshSnapshot();
    return ok({ success: true });
  }

  async disconnect(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelId = typeof body.channelId === 'string' ? body.channelId : '';
    if (!channelId) {
      return badRequest('channelId is required');
    }
    await this.deps.gateway.channelsDisconnect(channelId);
    await this.refreshSnapshot();
    return ok({ success: true });
  }

  async requestQr(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    if (!channelType) {
      return badRequest('channelType is required');
    }
    const result = await this.deps.gateway.channelsRequestQr(channelType);
    await this.refreshSnapshot();
    const qrResult = isRecord(result) ? result : {};
    return ok({
      success: true,
      qrCode: typeof qrResult.qrCode === 'string' ? qrResult.qrCode : '',
      sessionId: typeof qrResult.sessionId === 'string' ? qrResult.sessionId : '',
    });
  }

  async getConfigValues(channelType: string, accountId?: string) {
    return {
      success: true,
      values: await this.deps.channelConfig.getChannelFormValues(channelType, accountId),
    };
  }

  async listPairingRequests(channelType: string, accountId?: string) {
    if (!channelType) {
      return badRequest('channelType is required');
    }
    return ok(await this.deps.pairing.listRequests({ channelType, accountId }));
  }

  async approvePairingRequest(channelType: string, payload: unknown) {
    if (!channelType) {
      return badRequest('channelType is required');
    }
    const body = isRecord(payload) ? payload : {};
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) {
      return badRequest('code is required');
    }
    const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
    const result = await this.deps.pairing.approveRequest({ channelType, code, accountId });
    if (!result.approved) {
      return badRequest('pairing code not found or expired');
    }
    return ok(result);
  }

  deleteConfig(channelType: string) {
    return accepted(this.deps.jobs.submitDeleteChannelConfig({ channelType }));
  }

  probe() {
    return accepted(this.deps.jobs.submitProbeSnapshot());
  }
}
