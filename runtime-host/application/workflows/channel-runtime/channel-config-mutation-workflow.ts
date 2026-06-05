import type { ChannelConfigPort } from '../../channels/channel-runtime';
import type { ParentShellPort } from '../../runtime-host/parent-shell-port';

export interface ChannelConfigMutationWorkflowDeps {
  readonly channelConfig: Pick<ChannelConfigPort, 'saveChannelConfig' | 'deleteChannelConfig'>;
  readonly parentShell: Pick<ParentShellPort, 'request'>;
}

export class ChannelConfigMutationWorkflow {
  constructor(private readonly deps: ChannelConfigMutationWorkflowDeps) {}

  async executeActivateDirect(payload: unknown): Promise<{ success: true }> {
    await this.deps.channelConfig.saveChannelConfig(payload);
    await this.restartGateway();
    return { success: true };
  }

  async executeDeleteConfigDirect(channelType: string): Promise<{ success: true }> {
    await this.deps.channelConfig.deleteChannelConfig(channelType);
    await this.restartGateway();
    return { success: true };
  }

  private async restartGateway(): Promise<void> {
    const restartResponse = await this.deps.parentShell.request('gateway_restart');
    if (!restartResponse.success) {
      throw new Error(restartResponse.error?.message ?? 'gateway restart failed');
    }
  }
}
