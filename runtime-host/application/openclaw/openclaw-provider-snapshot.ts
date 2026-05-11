import {
  type OpenClawAuthRepository,
} from './openclaw-auth-store';
import type { OpenClawConfigRepositoryPort } from './openclaw-config-repository';
import type { RuntimeHostLogger } from '../../shared/logger';
import { addProvidersFromProfileEntries } from './openclaw-auth-provider-keys';

export type OpenClawProvidersSnapshot = {
  providers: Record<string, Record<string, unknown>>;
  defaultModel: string | undefined;
  activeProviders: Set<string>;
};

export class OpenClawProviderSnapshotService {
  constructor(
    private readonly configRepository: Pick<OpenClawConfigRepositoryPort, 'read'>,
    private readonly authRepository: Pick<OpenClawAuthRepository, 'discoverAgentIds' | 'readAuthProfiles'>,
    private readonly logger: RuntimeHostLogger,
  ) {}

  async getSnapshot(): Promise<OpenClawProvidersSnapshot> {
    try {
      const config = await this.configRepository.read();
      return await this.buildSnapshot(config);
    } catch (error) {
      this.logger.warn('Failed to read openclaw provider snapshot:', error);
      return { providers: {}, defaultModel: undefined, activeProviders: new Set<string>() };
    }
  }

  async getActiveProviders(): Promise<Set<string>> {
    const { activeProviders } = await this.getSnapshot();
    return activeProviders;
  }

  async getProvidersConfig(): Promise<{
    providers: Record<string, Record<string, unknown>>;
    defaultModel: string | undefined;
  }> {
    const { providers, defaultModel } = await this.getSnapshot();
    return { providers, defaultModel };
  }

  private async buildSnapshot(config: Record<string, unknown>): Promise<OpenClawProvidersSnapshot> {
    const models = (config.models && typeof config.models === 'object' && !Array.isArray(config.models))
      ? (config.models as Record<string, unknown>)
      : {};
    const providersRaw = (models.providers && typeof models.providers === 'object' && !Array.isArray(models.providers))
      ? (models.providers as Record<string, unknown>)
      : {};
    const providers = Object.fromEntries(
      Object.entries(providersRaw).map(([providerId, providerEntry]) => (
        [
          providerId,
          providerEntry && typeof providerEntry === 'object' && !Array.isArray(providerEntry)
            ? { ...(providerEntry as Record<string, unknown>) }
            : {},
        ] as const
      )),
    ) as Record<string, Record<string, unknown>>;
    const activeProviders = new Set<string>(Object.keys(providers));

    const agents = (config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents))
      ? (config.agents as Record<string, unknown>)
      : {};
    const defaults = (agents.defaults && typeof agents.defaults === 'object' && !Array.isArray(agents.defaults))
      ? (agents.defaults as Record<string, unknown>)
      : {};
    const modelConfig = (defaults.model && typeof defaults.model === 'object' && !Array.isArray(defaults.model))
      ? (defaults.model as Record<string, unknown>)
      : {};
    const defaultModel = typeof modelConfig.primary === 'string' ? modelConfig.primary : undefined;
    if (defaultModel?.includes('/')) {
      activeProviders.add(defaultModel.split('/')[0]);
    }

    const plugins = (config.plugins as Record<string, unknown> | undefined)?.entries;
    if (plugins && typeof plugins === 'object') {
      for (const [pluginId, meta] of Object.entries(plugins as Record<string, unknown>)) {
        if (pluginId.endsWith('-auth') && (meta as Record<string, unknown>).enabled) {
          activeProviders.add(pluginId.replace(/-auth$/, ''));
        }
      }
    }

    const authProviders = new Set<string>();
    const auth = config.auth as Record<string, unknown> | undefined;
    addProvidersFromProfileEntries(auth?.profiles as Record<string, unknown> | undefined, authProviders);

    const authProfileProviders = await this.getProvidersFromAuthProfileStores();
    for (const provider of authProfileProviders) {
      authProviders.add(provider);
    }

    for (const provider of authProviders) {
      if (!providers[provider]) {
        providers[provider] = {};
      }
      activeProviders.add(provider);
    }

    return { providers, defaultModel, activeProviders };
  }

  private async getProvidersFromAuthProfileStores(): Promise<Set<string>> {
    const providers = new Set<string>();
    const agentIds = await this.authRepository.discoverAgentIds();

    for (const agentId of agentIds) {
      const store = await this.authRepository.readAuthProfiles(agentId);
      addProvidersFromProfileEntries(store.profiles, providers);
    }

    return providers;
  }
}
