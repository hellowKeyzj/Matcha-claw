import type { RuntimeClockPort } from '../../common/runtime-ports';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function replaceConfigContents(target: Record<string, unknown>, source: Record<string, unknown>): void {
  if (target === source) {
    return;
  }
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}

export interface ChannelRuntimeConfigStorePort {
  read(): Promise<Record<string, unknown>>;
  updateDirty<T>(mutate: (config: Record<string, unknown>) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean }): Promise<T>;
  patchSection<T>(sectionKey: string, mutate: (value: unknown, config: Record<string, unknown>) => Promise<{ result: T; value: unknown; changed: boolean }> | { result: T; value: unknown; changed: boolean }): Promise<T>;
}

export interface ChannelConfigProjectionPort {
  getChannelPluginId(channelType: string): string | null;
  listConfiguredChannels(config: Record<string, unknown>): string[];
  saveChannelConfig(config: Record<string, unknown>, input: Record<string, unknown>, nowIso: string): void;
  getChannelFormValues(config: Record<string, unknown>, channelType: string, accountId?: string): Record<string, string>;
  deleteChannelConfig(config: Record<string, unknown>, channelType: string): void;
}

export interface ChannelPluginConfigProjectionPort {
  reconcileChannelDerivedPluginState(config: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ChannelPluginProvisionerPort {
  ensureChannelPluginInstalled(pluginId: string, options?: { force?: boolean }): Promise<void>;
}

export interface ChannelConfigWorkflowDeps {
  readonly configRepository: ChannelRuntimeConfigStorePort;
  readonly configProjection: ChannelConfigProjectionPort;
  readonly pluginProjection: ChannelPluginConfigProjectionPort;
  readonly pluginProvisioner: ChannelPluginProvisionerPort;
  readonly clock: RuntimeClockPort;
}

export class ChannelConfigWorkflow {
  constructor(private readonly deps: ChannelConfigWorkflowDeps) {}

  async listConfiguredChannels() {
    const config = await this.deps.configRepository.read();
    return this.deps.configProjection.listConfiguredChannels(config);
  }

  async reconcileConfiguredChannelPlugins(
    configuredChannelsInput?: readonly string[],
    options: { forceInstall?: boolean } = {},
  ): Promise<string[]> {
    const configuredChannels = configuredChannelsInput
      ? [...new Set(configuredChannelsInput)]
      : await this.listConfiguredChannels();

    for (const channelType of configuredChannels) {
      const externalPluginId = this.deps.configProjection.getChannelPluginId(channelType);
      if (externalPluginId) {
        await this.ensureChannelPluginInstalled(externalPluginId, { force: options.forceInstall === true });
      }
    }

    await this.reconcileChannelDerivedPluginState();
    return configuredChannels;
  }

  async prepareChannelPlugin(channelType: string): Promise<void> {
    const externalPluginId = this.deps.configProjection.getChannelPluginId(channelType.trim());
    if (!externalPluginId) {
      return;
    }
    await this.ensureChannelPluginInstalled(externalPluginId);
  }

  async saveChannelConfig(input: unknown) {
    if (!isRecord(input)) {
      throw new Error('Invalid channel config payload');
    }
    const channelType = typeof input.channelType === 'string' ? input.channelType.trim() : '';
    if (!channelType) {
      throw new Error('channelType is required');
    }

    await this.prepareChannelPlugin(channelType);

    await this.deps.configRepository.patchSection('channels', (channels) => {
      const config = { channels: isRecord(channels) ? channels : {} };
      this.deps.configProjection.saveChannelConfig(config, input, this.deps.clock.nowIso());
      return { result: undefined, value: config.channels, changed: true };
    });
    await this.reconcileChannelDerivedPluginState();
  }

  async getChannelFormValues(channelType: string, accountId?: string) {
    const config = await this.deps.configRepository.read();
    return this.deps.configProjection.getChannelFormValues(config, channelType, accountId);
  }

  async deleteChannelConfig(channelType: string) {
    await this.deps.configRepository.patchSection('channels', (channels) => {
      const channelSections = isRecord(channels) ? channels : {};
      const changed = Object.prototype.hasOwnProperty.call(channelSections, channelType);
      const config = { channels: channelSections };
      this.deps.configProjection.deleteChannelConfig(config, channelType);
      return { result: undefined, value: config.channels, changed };
    });
    await this.reconcileChannelDerivedPluginState();
  }

  async validateChannelConfig(channelType: string) {
    const configuredChannels = await this.listConfiguredChannels();
    const normalizedType = typeof channelType === 'string' ? channelType.trim() : '';
    if (!normalizedType) {
      return { valid: false, errors: ['channelType is required'], warnings: [] };
    }
    const valid = configuredChannels.includes(normalizedType);
    return {
      valid,
      errors: valid ? [] : [`Channel ${normalizedType} is not configured`],
      warnings: [],
    };
  }

  async validateChannelCredentials(_channelType: string, _config: Record<string, unknown>) {
    return {
      valid: true,
      errors: [],
      warnings: [],
    };
  }

  private async reconcileChannelDerivedPluginState(): Promise<void> {
    await this.deps.configRepository.updateDirty(async (config) => {
      await this.reconcileChannelDerivedPluginStateInPlace(config);
      return { result: undefined, changed: true };
    });
  }

  private async reconcileChannelDerivedPluginStateInPlace(config: Record<string, unknown>): Promise<void> {
    const nextConfig = await this.deps.pluginProjection.reconcileChannelDerivedPluginState(config);
    replaceConfigContents(config, nextConfig);
  }

  private async ensureChannelPluginInstalled(
    pluginId: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    await this.deps.pluginProvisioner.ensureChannelPluginInstalled(pluginId, options);
  }
}
