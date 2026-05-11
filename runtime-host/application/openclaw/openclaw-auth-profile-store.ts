import {
  type AuthProfileEntry,
  type AuthProfilesStore,
  type OpenClawAuthRepository,
  type OAuthProfileEntry,
} from './openclaw-auth-store';
import { isOAuthProviderType } from '../providers/provider-runtime-rules';
import type { RuntimeHostLogger } from '../../shared/logger';

export function removeProfilesForProvider(store: AuthProfilesStore, provider: string): boolean {
  const removedProfileIds = new Set<string>();

  for (const [profileId, profile] of Object.entries(store.profiles)) {
    if (profile?.provider !== provider) {
      continue;
    }
    delete store.profiles[profileId];
    removedProfileIds.add(profileId);
  }

  if (removedProfileIds.size === 0) {
    return false;
  }

  if (store.order) {
    for (const [orderProvider, profileIds] of Object.entries(store.order)) {
      const nextProfileIds = profileIds.filter((profileId) => !removedProfileIds.has(profileId));
      if (nextProfileIds.length > 0) {
        store.order[orderProvider] = nextProfileIds;
      } else {
        delete store.order[orderProvider];
      }
    }
  }

  if (store.lastGood) {
    for (const [lastGoodProvider, profileId] of Object.entries(store.lastGood)) {
      if (removedProfileIds.has(profileId)) {
        delete store.lastGood[lastGoodProvider];
      }
    }
  }

  return true;
}

export function removeProfileFromStore(
  store: AuthProfilesStore,
  profileId: string,
  expectedType?: AuthProfileEntry['type'] | OAuthProfileEntry['type'],
): boolean {
  const profile = store.profiles[profileId];
  let changed = false;
  const shouldCleanReferences = !profile || !expectedType || profile.type === expectedType;

  if (profile && (!expectedType || profile.type === expectedType)) {
    delete store.profiles[profileId];
    changed = true;
  }

  if (shouldCleanReferences && store.order) {
    for (const [orderProvider, profileIds] of Object.entries(store.order)) {
      const nextProfileIds = profileIds.filter((id) => id !== profileId);
      if (nextProfileIds.length !== profileIds.length) {
        changed = true;
      }
      if (nextProfileIds.length > 0) {
        store.order[orderProvider] = nextProfileIds;
      } else {
        delete store.order[orderProvider];
      }
    }
  }

  if (shouldCleanReferences && store.lastGood) {
    for (const [lastGoodProvider, lastGoodProfileId] of Object.entries(store.lastGood)) {
      if (lastGoodProfileId === profileId) {
        delete store.lastGood[lastGoodProvider];
        changed = true;
      }
    }
  }

  return changed;
}

export class OpenClawAuthProfileService {
  constructor(
    private readonly repository: Pick<OpenClawAuthRepository, 'discoverAgentIds' | 'readAuthProfiles' | 'writeAuthProfiles'>,
    private readonly logger: RuntimeHostLogger,
  ) {}

  async saveOAuthToken(
    provider: string,
    token: { access: string; refresh: string; expires: number; email?: string; projectId?: string },
    agentId?: string,
  ): Promise<void> {
    const agentIds = await this.resolveAgentIds(agentId);

    for (const id of agentIds) {
      const store = await this.repository.readAuthProfiles(id);
      const profileId = `${provider}:default`;

      store.profiles[profileId] = {
        type: 'oauth',
        provider,
        access: token.access,
        refresh: token.refresh,
        expires: token.expires,
        email: token.email,
        projectId: token.projectId,
      };

      if (!store.order) store.order = {};
      if (!store.order[provider]) store.order[provider] = [];
      if (!store.order[provider].includes(profileId)) {
        store.order[provider].push(profileId);
      }

      if (!store.lastGood) store.lastGood = {};
      store.lastGood[provider] = profileId;

      await this.repository.writeAuthProfiles(store, id);
    }
    this.logger.info(`Saved OAuth token for provider "${provider}" to OpenClaw auth-profiles (agents: ${agentIds.join(', ')})`);
  }

  async getOAuthToken(
    provider: string,
    agentId = 'main',
  ): Promise<string | null> {
    try {
      const store = await this.repository.readAuthProfiles(agentId);
      const profileId = `${provider}:default`;
      const profile = store.profiles[profileId];

      if (profile && profile.type === 'oauth' && 'access' in profile) {
        return (profile as OAuthProfileEntry).access;
      }
    } catch (error) {
      this.logger.warn(`[getOAuthToken] Failed to read token for ${provider}:`, error);
    }
    return null;
  }

  async getProviderApiKey(
    provider: string,
    agentId?: string,
  ): Promise<string | null> {
    const agentIds = await this.resolveAgentIds(agentId);

    for (const id of agentIds) {
      const store = await this.repository.readAuthProfiles(id);
      const apiKey = getApiKeyFromAuthProfilesStore(store, provider);
      if (apiKey) {
        return apiKey;
      }
    }

    return null;
  }

  async saveProviderKey(
    provider: string,
    apiKey: string,
    agentId?: string,
  ): Promise<void> {
    if (isOAuthProviderType(provider) && !apiKey) {
      this.logger.info(`Skipping auth-profiles write for OAuth provider "${provider}" (no API key provided, using OAuth)`);
      return;
    }

    const agentIds = await this.resolveAgentIds(agentId);

    for (const id of agentIds) {
      const store = await this.repository.readAuthProfiles(id);
      const profileId = `${provider}:default`;

      store.profiles[profileId] = { type: 'api_key', provider, key: apiKey };

      if (!store.order) store.order = {};
      if (!store.order[provider]) store.order[provider] = [];
      if (!store.order[provider].includes(profileId)) {
        store.order[provider].push(profileId);
      }

      if (!store.lastGood) store.lastGood = {};
      store.lastGood[provider] = profileId;

      await this.repository.writeAuthProfiles(store, id);
    }
    this.logger.info(`Saved API key for provider "${provider}" to OpenClaw auth-profiles (agents: ${agentIds.join(', ')})`);
  }

  async removeProviderKey(
    provider: string,
    agentId?: string,
  ): Promise<void> {
    const agentIds = await this.resolveAgentIds(agentId);

    for (const id of agentIds) {
      const store = await this.repository.readAuthProfiles(id);
      if (removeProfileFromStore(store, `${provider}:default`, 'api_key')) {
        await this.repository.writeAuthProfiles(store, id);
      }
    }
    this.logger.info(`Removed API key for provider "${provider}" from OpenClaw auth-profiles (agents: ${agentIds.join(', ')})`);
  }

  private async resolveAgentIds(agentId?: string): Promise<string[]> {
    const agentIds = agentId ? [agentId] : await this.repository.discoverAgentIds();
    if (agentIds.length === 0) {
      agentIds.push('main');
    }
    return agentIds;
  }
}

function getApiKeyFromAuthProfilesStore(
  store: AuthProfilesStore,
  provider: string,
): string | null {
  const profileIds = [
    store.lastGood?.[provider],
    ...(store.order?.[provider] ?? []),
    `${provider}:default`,
  ].filter((profileId): profileId is string => Boolean(profileId));

  for (const profileId of profileIds) {
    const profile = store.profiles[profileId];
    if (profile?.type === 'api_key' && profile.provider === provider && profile.key) {
      return profile.key;
    }
  }

  for (const profile of Object.values(store.profiles)) {
    if (profile.type === 'api_key' && profile.provider === provider && profile.key) {
      return profile.key;
    }
  }

  return null;
}
