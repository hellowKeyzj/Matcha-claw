import {
  accepted,
  applicationResponse,
  badRequest,
  ok,
  type ApplicationResponse,
} from '../common/application-response';
import type { RuntimeClockPort } from '../common/runtime-ports';
import type { GatewayChannelPort } from '../gateway/gateway-runtime-port';
import type { ParentShellPort } from '../runtime-host/parent-shell-port';
import { channelUsesLoginSession } from './channel-activation-strategy';
import type { ChannelJobPort } from './channel-jobs';
import type { ChannelConfigPort } from './channel-runtime';
import type { ChannelLoginSessionService } from './channel-login-session-service';

export interface ChannelServiceDeps {
  readonly gateway: GatewayChannelPort;
  readonly channelConfig: ChannelConfigPort;
  readonly parentShell: ParentShellPort;
  readonly loginSessions: Pick<ChannelLoginSessionService, 'start' | 'cancel'>;
  readonly jobs: ChannelJobPort;
  readonly clock: RuntimeClockPort;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class ChannelService {
  private snapshotValue: unknown = null;
  private snapshotReady = false;
  private snapshotError: string | null = null;
  private snapshotUpdatedAt: number | null = null;
  private snapshotRefreshTask: Promise<unknown> | null = null;

  constructor(private readonly deps: ChannelServiceDeps) {}

  async restartGateway(): Promise<ApplicationResponse> {
    const restartResponse = await this.deps.parentShell.request('gateway_restart');
    if (!restartResponse.success) {
      return applicationResponse(restartResponse.status, { success: false, error: restartResponse.error.message });
    }
    return applicationResponse(restartResponse.status, { success: true });
  }

  async activateDirect(payload: unknown): Promise<ApplicationResponse> {
    await this.deps.channelConfig.saveChannelConfig(payload);
    return await this.restartGateway();
  }

  async setEnabledDirect(channelType: string, enabled: boolean): Promise<ApplicationResponse> {
    await this.deps.channelConfig.setChannelEnabled(channelType, enabled);
    return await this.restartGateway();
  }

  async deleteConfigDirect(channelType: string): Promise<ApplicationResponse> {
    await this.deps.channelConfig.deleteChannelConfig(channelType);
    return await this.restartGateway();
  }

  snapshot() {
    void this.refreshSnapshotInBackground();
    return {
      success: true,
      snapshot: this.snapshotValue,
      ready: this.snapshotReady,
      refreshing: this.snapshotRefreshTask !== null,
      updatedAt: this.snapshotUpdatedAt,
      error: this.snapshotError,
    };
  }

  private refreshSnapshotInBackground(): Promise<unknown> {
    if (this.snapshotRefreshTask) {
      return this.snapshotRefreshTask;
    }
    const task = this.refreshSnapshot()
      .catch((error) => {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      })
      .finally(() => {
        if (this.snapshotRefreshTask === task) {
          this.snapshotRefreshTask = null;
        }
      });
    this.snapshotRefreshTask = task;
    return task;
  }

  async refreshSnapshot() {
    try {
      this.snapshotValue = await this.deps.gateway.channelsStatus(true);
      this.snapshotReady = true;
      this.snapshotError = null;
      this.snapshotUpdatedAt = this.deps.clock.nowMs();
      return {
        success: true,
        snapshot: this.snapshotValue,
        updatedAt: this.snapshotUpdatedAt,
      };
    } catch (error) {
      this.snapshotError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async configured() {
    return {
      success: true,
      channels: await this.deps.channelConfig.listConfiguredChannels(),
    };
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

  async setEnabled(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    if (!channelType) {
      return badRequest('channelType is required');
    }
    return accepted(this.deps.jobs.submitSetChannelEnabled({
      channelType,
      enabled: body.enabled === true,
    }));
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

  deleteConfig(channelType: string) {
    return accepted(this.deps.jobs.submitDeleteChannelConfig({ channelType }));
  }
}
