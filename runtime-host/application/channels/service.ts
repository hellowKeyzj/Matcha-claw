import {
  accepted,
  badRequest,
  ok,
} from '../common/application-response';
import type { ChannelActivationWorkflow } from '../workflows/channel-runtime/channel-activation-workflow';
import type { ChannelConfigMutationWorkflow } from '../workflows/channel-runtime/channel-config-mutation-workflow';
import type { ChannelRuntimeWorkflow } from '../workflows/channel-runtime/channel-runtime-workflow';
import type { ChannelJobPort } from './channel-jobs';
import type { ChannelPairingService } from './channel-pairing-service';
import type { ChannelConfigPort } from './channel-runtime';
export interface ChannelServiceDeps {
  readonly channelConfig: ChannelConfigPort;
  readonly activationWorkflow: Pick<ChannelActivationWorkflow, 'activate' | 'cancelSession'>;
  readonly configMutationWorkflow: Pick<ChannelConfigMutationWorkflow, 'executeActivateDirect' | 'executeDeleteConfigDirect'>;
  readonly runtimeWorkflow: Pick<ChannelRuntimeWorkflow, 'snapshot' | 'refreshSnapshot' | 'probeSnapshot' | 'connect' | 'disconnect' | 'requestQr'>;
  readonly pairing: Pick<ChannelPairingService, 'listRequests' | 'approveRequest'>;
  readonly jobs: ChannelJobPort;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class ChannelService {
  constructor(private readonly deps: ChannelServiceDeps) {}

  async activateDirect(payload: unknown): Promise<{ success: true }> {
    return await this.deps.configMutationWorkflow.executeActivateDirect(payload);
  }

  async deleteConfigDirect(channelType: string): Promise<{ success: true }> {
    return await this.deps.configMutationWorkflow.executeDeleteConfigDirect(channelType);
  }

  async snapshot() {
    return await this.deps.runtimeWorkflow.snapshot();
  }

  async refreshSnapshot() {
    return await this.deps.runtimeWorkflow.refreshSnapshot();
  }

  async probeSnapshot() {
    return await this.deps.runtimeWorkflow.probeSnapshot();
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
    return await this.deps.activationWorkflow.activate(channelType, payload);
  }

  async cancelSession(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    if (!channelType) {
      return badRequest('channelType is required');
    }
    return await this.deps.activationWorkflow.cancelSession(channelType);
  }

  async connect(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    const accountId = typeof body.accountId === 'string' && body.accountId.trim() ? body.accountId : undefined;
    if (!channelType) {
      return badRequest('channelType is required');
    }
    return ok(await this.deps.runtimeWorkflow.connect(channelType, accountId));
  }

  async disconnect(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    const accountId = typeof body.accountId === 'string' && body.accountId.trim() ? body.accountId : undefined;
    if (!channelType) {
      return badRequest('channelType is required');
    }
    return ok(await this.deps.runtimeWorkflow.disconnect(channelType, accountId));
  }

  async requestQr(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const channelType = typeof body.channelType === 'string' ? body.channelType : '';
    if (!channelType) {
      return badRequest('channelType is required');
    }
    return ok(await this.deps.runtimeWorkflow.requestQr(channelType));
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
