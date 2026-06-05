import type {
  ChannelConfigProjectionPort,
  ChannelConfigWorkflow,
  ChannelPluginConfigProjectionPort,
  ChannelPluginProvisionerPort,
  ChannelRuntimeConfigStorePort,
} from '../workflows/channel-runtime/channel-config-workflow';

export type {
  ChannelConfigProjectionPort,
  ChannelPluginConfigProjectionPort,
  ChannelPluginProvisionerPort,
  ChannelRuntimeConfigStorePort,
};

export class ChannelConfigRepository {
  constructor(
    private readonly configWorkflow: Pick<ChannelConfigWorkflow,
      | 'listConfiguredChannels'
      | 'reconcileConfiguredChannelPlugins'
      | 'prepareChannelPlugin'
      | 'saveChannelConfig'
      | 'getChannelFormValues'
      | 'deleteChannelConfig'
      | 'validateChannelConfig'
      | 'validateChannelCredentials'
    >,
  ) {}

  async listConfiguredChannels() {
    return await this.configWorkflow.listConfiguredChannels();
  }

  async reconcileConfiguredChannelPlugins(
    configuredChannelsInput?: readonly string[],
    options: { forceInstall?: boolean } = {},
  ): Promise<string[]> {
    return await this.configWorkflow.reconcileConfiguredChannelPlugins(configuredChannelsInput, options);
  }

  async prepareChannelPlugin(channelType: string): Promise<void> {
    await this.configWorkflow.prepareChannelPlugin(channelType);
  }

  async saveChannelConfig(input: unknown) {
    await this.configWorkflow.saveChannelConfig(input);
  }

  async getChannelFormValues(channelType: string, accountId?: string) {
    return await this.configWorkflow.getChannelFormValues(channelType, accountId);
  }

  async deleteChannelConfig(channelType: string) {
    await this.configWorkflow.deleteChannelConfig(channelType);
  }

  async validateChannelConfig(channelType: string) {
    return await this.configWorkflow.validateChannelConfig(channelType);
  }

  async validateChannelCredentials(channelType: string, config: Record<string, unknown>) {
    return await this.configWorkflow.validateChannelCredentials(channelType, config);
  }
}

export interface ChannelConfigPort extends Pick<
  ChannelConfigRepository,
  | 'listConfiguredChannels'
  | 'validateChannelConfig'
  | 'validateChannelCredentials'
  | 'prepareChannelPlugin'
  | 'saveChannelConfig'
  | 'getChannelFormValues'
  | 'deleteChannelConfig'
> {}
