import {
  isOpenClawOAuthPluginProviderKey,
} from '../../projections/openclaw-provider-projection-rules';
import { removeProfilesForProvider } from '../openclaw-auth/openclaw-auth-profile-workflow';
import type { OpenClawConfigRepositoryPort } from '../../infrastructure/openclaw-config-repository';
import type { OpenClawAuthRepository } from '../../infrastructure/openclaw-auth-store';
import {
  applyOAuthPluginRegistration,
  applyOAuthPluginRegistrationRemoval,
  type OAuthPluginRegistration,
  type OpenClawOAuthPluginRegistrationService,
} from '../../projections/openclaw-oauth-plugin-registration';
import type { OpenClawAgentModelRepositoryPort } from '../../infrastructure/openclaw-agent-model-repository';
import { pruneProviderModelRefsInAgentsConfig } from '../../projections/openclaw-provider-model-pruning';
import {
  type RuntimeConfigProviderOverride,
  upsertOpenClawProviderEntry,
} from '../../projections/openclaw-provider-entry-builder';
import { expandProviderKeysForDeletion } from '../../infrastructure/openclaw-auth-provider-keys';
import {
  ensureMoonshotKimiWebSearchBaseUrl,
  removeProviderAuthProfilesFromConfig,
  removeProviderEntryFromModelsConfig,
} from '../../projections/openclaw-provider-config-rules';
import type { RuntimeHostLogger } from '../../../../../shared/logger';

export interface OpenClawProviderConfigWorkflowDeps {
  readonly configRepository: OpenClawConfigRepositoryPort;
  readonly authRepository: Pick<OpenClawAuthRepository, 'discoverAgentIds' | 'readAuthProfiles' | 'writeAuthProfiles'>;
  readonly oauthPlugins: Pick<OpenClawOAuthPluginRegistrationService, 'resolveOAuthPluginRegistration'>;
  readonly agentModels: OpenClawAgentModelRepositoryPort;
  readonly logger: RuntimeHostLogger;
}

export class OpenClawProviderConfigWorkflow {
  constructor(private readonly deps: OpenClawProviderConfigWorkflowDeps) {}

  async syncProviderConfig(
    provider: string,
    override: RuntimeConfigProviderOverride,
  ): Promise<void> {
    const oauthRegistration = isOpenClawOAuthPluginProviderKey(provider)
      ? await this.deps.oauthPlugins.resolveOAuthPluginRegistration(provider)
      : null;
    await this.deps.configRepository.updateDirty((config) => {
      let modified = ensureMoonshotKimiWebSearchBaseUrl(config, provider);

      if (override.baseUrl && override.api) {
        if (upsertOpenClawProviderEntry(config, provider, {
          baseUrl: override.baseUrl,
          api: override.api,
          apiKeyEnv: override.apiKeyEnv,
          headers: override.headers,
          authHeader: override.authHeader,
          replaceProviderKeys: override.replaceProviderKeys,
        })) {
          modified = true;
        }
      }

      if (oauthRegistration && applyOAuthPluginRegistration(config, oauthRegistration, this.deps.logger)) {
        modified = true;
        this.deps.logger.info(`Enabled OpenClaw OAuth plugin for provider "${provider}"`);
      }
      return { result: undefined, changed: modified };
    });
  }

  async removeProvider(provider: string): Promise<void> {
    const providerKeysToRemove = expandProviderKeysForDeletion(provider);
    const agentIds = await this.resolveAgentIds();

    for (const id of agentIds) {
      const store = await this.deps.authRepository.readAuthProfiles(id);
      let modified = false;
      for (const providerKey of providerKeysToRemove) {
        if (removeProfilesForProvider(store, providerKey)) {
          modified = true;
        }
      }
      if (modified) {
        await this.deps.authRepository.writeAuthProfiles(store, id);
      }
    }

    await this.removeProviderFromAgentModels(provider, agentIds);
    await this.removeProviderFromOpenClawConfig(provider);
  }

  private async resolveAgentIds(): Promise<string[]> {
    const agentIds = await this.deps.authRepository.discoverAgentIds();
    if (agentIds.length === 0) {
      agentIds.push('main');
    }
    return agentIds;
  }

  private async removeProviderFromAgentModels(provider: string, agentIds: readonly string[]): Promise<void> {
    try {
      const touchedAgentIds = await this.deps.agentModels.removeProviderFromAgentModels({ agentIds, provider });
      for (const id of touchedAgentIds) {
        this.deps.logger.info(`Removed models.json entry for provider "${provider}" (agent "${id}")`);
      }
    } catch (error) {
      this.deps.logger.warn(`Failed to remove provider ${provider} from agent models.json files:`, error);
    }
  }

  private async removeProviderFromOpenClawConfig(provider: string): Promise<void> {
    try {
      const oauthRegistration = await this.deps.oauthPlugins.resolveOAuthPluginRegistration(provider);
      await this.deps.configRepository.updateDirty((config) => {
        let modified = false;

        if (applyOAuthPluginRegistrationRemoval(config, oauthRegistration)) {
          modified = true;
          this.deps.logger.info(`Removed OpenClaw OAuth plugin registrations for provider "${provider}"`);
        }

        if (removeProviderEntryFromModelsConfig(config, provider)) {
          modified = true;
          this.deps.logger.info(`Removed OpenClaw provider config: ${provider}`);
        }

        const removedProfileIds = removeProviderAuthProfilesFromConfig(
          config,
          new Set(expandProviderKeysForDeletion(provider)),
        );
        for (const profileId of removedProfileIds) {
          modified = true;
          this.deps.logger.info(`Removed OpenClaw auth profile: ${profileId}`);
        }

        if (pruneProviderModelRefsInAgentsConfig(config, provider)) {
          modified = true;
          this.deps.logger.info(`Pruned stale agent model references for provider "${provider}"`);
        }

        if (modified) {
          markRestartCommand(config);
        }
        return { result: undefined, changed: modified };
      });
    } catch (error) {
      this.deps.logger.warn(`Failed to remove provider ${provider} from openclaw.json:`, error);
    }
  }
}

function markRestartCommand(config: Record<string, unknown>): void {
  const commands = (
    config.commands && typeof config.commands === 'object'
      ? { ...(config.commands as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  commands.restart = true;
  config.commands = commands;
}
