import {
  getProviderEnvVar,
} from '../providers/provider-registry';
import {
  isOpenClawOAuthPluginProviderKey,
} from '../providers/provider-runtime-rules';
import {
  type OpenClawAuthRepository,
} from './openclaw-auth-store';
import { removeProfilesForProvider } from './openclaw-auth-profile-store';
import type { RuntimeHostLogger } from '../../shared/logger';
import type { OpenClawConfigRepositoryPort } from './openclaw-config-repository';
import type { OpenClawOAuthPluginRegistrationService } from './openclaw-oauth-plugin-registration';
import type { OpenClawAgentModelRepositoryPort } from './openclaw-agent-model-repository';
import { pruneProviderModelRefsInAgentsConfig } from './openclaw-provider-model-pruning';
import {
  type RuntimeProviderConfigOverride,
  upsertOpenClawProviderEntry,
} from './openclaw-provider-entry-builder';
import { expandProviderKeysForDeletion } from './openclaw-auth-provider-keys';
import {
  ensureMoonshotKimiWebSearchBaseUrl,
  removeProviderAuthProfilesFromConfig,
  removeProviderEntryFromModelsConfig,
} from './openclaw-provider-config-rules';

export class OpenClawProviderConfigService {
  constructor(
    private readonly configRepository: OpenClawConfigRepositoryPort,
    private readonly authRepository: Pick<OpenClawAuthRepository, 'discoverAgentIds' | 'readAuthProfiles' | 'writeAuthProfiles'>,
    private readonly oauthPlugins: Pick<OpenClawOAuthPluginRegistrationService, 'ensureOAuthPluginEnabled' | 'removeOAuthPluginRegistrations'>,
    private readonly agentModels: OpenClawAgentModelRepositoryPort,
    private readonly logger: RuntimeHostLogger,
  ) {}

  async syncProviderConfig(
    provider: string,
    override: RuntimeProviderConfigOverride,
  ): Promise<void> {
    await this.configRepository.update(async (config) => {
      ensureMoonshotKimiWebSearchBaseUrl(config, provider);

      if (override.baseUrl && override.api) {
        if (upsertOpenClawProviderEntry(config, provider, {
          baseUrl: override.baseUrl,
          api: override.api,
          apiKeyEnv: override.apiKeyEnv,
          headers: override.headers,
          authHeader: override.authHeader,
        })) {
          this.logger.info('Removed legacy models.providers.moonshot alias entry');
        }
      }

      if (isOpenClawOAuthPluginProviderKey(provider) && await this.oauthPlugins.ensureOAuthPluginEnabled(config, provider)) {
        this.logger.info(`Enabled OpenClaw OAuth plugin for provider "${provider}"`);
      }
    });
  }

  async removeProvider(provider: string): Promise<void> {
    const providerKeysToRemove = expandProviderKeysForDeletion(provider);
    const agentIds = await this.authRepository.discoverAgentIds();
    if (agentIds.length === 0) {
      agentIds.push('main');
    }

    for (const id of agentIds) {
      const store = await this.authRepository.readAuthProfiles(id);
      let modified = false;
      for (const providerKey of providerKeysToRemove) {
        if (removeProfilesForProvider(store, providerKey)) {
          modified = true;
        }
      }
      if (modified) {
        await this.authRepository.writeAuthProfiles(store, id);
      }
    }

    try {
      const touchedAgentIds = await this.agentModels.removeProviderFromAgentModels({ agentIds, provider });
      for (const id of touchedAgentIds) {
        this.logger.info(`Removed models.json entry for provider "${provider}" (agent "${id}")`);
      }
    } catch (error) {
      this.logger.warn(`Failed to remove provider ${provider} from agent models.json files:`, error);
    }

    try {
      await this.configRepository.update(async (config) => {
        let modified = false;

        if (await this.oauthPlugins.removeOAuthPluginRegistrations(config, provider)) {
          modified = true;
          this.logger.info(`Removed OpenClaw OAuth plugin registrations for provider "${provider}"`);
        }

        if (removeProviderEntryFromModelsConfig(config, provider)) {
          modified = true;
          this.logger.info(`Removed OpenClaw provider config: ${provider}`);
        }

        const removedProfileIds = removeProviderAuthProfilesFromConfig(
          config,
          new Set(expandProviderKeysForDeletion(provider)),
        );
        for (const profileId of removedProfileIds) {
          modified = true;
          this.logger.info(`Removed OpenClaw auth profile: ${profileId}`);
        }

        if (pruneProviderModelRefsInAgentsConfig(config, provider)) {
          modified = true;
          this.logger.info(`Pruned stale agent model references for provider "${provider}"`);
        }

        if (modified) {
          this.markRestartCommand(config);
        }
      });
    } catch (error) {
      this.logger.warn(`Failed to remove provider ${provider} from openclaw.json:`, error);
    }
  }

  private markRestartCommand(config: Record<string, unknown>): void {
    const commands = (
      config.commands && typeof config.commands === 'object'
        ? { ...(config.commands as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    commands.restart = true;
    config.commands = commands;
  }
}

export function buildProviderEnvVars(providers: Array<{ type: string; apiKey: string }>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { type, apiKey } of providers) {
    const envVar = getProviderEnvVar(type);
    if (envVar && apiKey) {
      env[envVar] = apiKey;
    }
  }
  return env;
}

export { getProviderEnvVar } from '../providers/provider-registry';
