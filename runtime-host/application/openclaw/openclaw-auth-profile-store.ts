import {
  type AuthProfileEntry,
  type AuthProfilesStore,
  discoverAgentIds,
  readAuthProfiles,
  type OAuthProfileEntry,
  writeAuthProfiles,
} from './openclaw-auth-store';
import { isOAuthProviderType } from '../providers/provider-runtime-rules';
import { createRuntimeLogger } from '../../shared/logger';

const logger = createRuntimeLogger('openclaw-auth-profile-store');

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

export async function saveOAuthTokenToOpenClaw(
  provider: string,
  token: { access: string; refresh: string; expires: number; email?: string; projectId?: string },
  agentId?: string,
): Promise<void> {
  const agentIds = agentId ? [agentId] : await discoverAgentIds();
  if (agentIds.length === 0) {
    agentIds.push('main');
  }

  for (const id of agentIds) {
    const store = await readAuthProfiles(id);
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

    await writeAuthProfiles(store, id);
  }
  logger.info(`Saved OAuth token for provider "${provider}" to OpenClaw auth-profiles (agents: ${agentIds.join(', ')})`);
}

export async function getOAuthTokenFromOpenClaw(
  provider: string,
  agentId = 'main',
): Promise<string | null> {
  try {
    const store = await readAuthProfiles(agentId);
    const profileId = `${provider}:default`;
    const profile = store.profiles[profileId];

    if (profile && profile.type === 'oauth' && 'access' in profile) {
      return (profile as OAuthProfileEntry).access;
    }
  } catch (error) {
    logger.warn(`[getOAuthToken] Failed to read token for ${provider}:`, error);
  }
  return null;
}

export async function saveProviderKeyToOpenClaw(
  provider: string,
  apiKey: string,
  agentId?: string,
): Promise<void> {
  if (isOAuthProviderType(provider) && !apiKey) {
    logger.info(`Skipping auth-profiles write for OAuth provider "${provider}" (no API key provided, using OAuth)`);
    return;
  }

  const agentIds = agentId ? [agentId] : await discoverAgentIds();
  if (agentIds.length === 0) {
    agentIds.push('main');
  }

  for (const id of agentIds) {
    const store = await readAuthProfiles(id);
    const profileId = `${provider}:default`;

    store.profiles[profileId] = { type: 'api_key', provider, key: apiKey };

    if (!store.order) store.order = {};
    if (!store.order[provider]) store.order[provider] = [];
    if (!store.order[provider].includes(profileId)) {
      store.order[provider].push(profileId);
    }

    if (!store.lastGood) store.lastGood = {};
    store.lastGood[provider] = profileId;

    await writeAuthProfiles(store, id);
  }
  logger.info(`Saved API key for provider "${provider}" to OpenClaw auth-profiles (agents: ${agentIds.join(', ')})`);
}

export async function removeProviderKeyFromOpenClaw(
  provider: string,
  agentId?: string,
): Promise<void> {
  const agentIds = agentId ? [agentId] : await discoverAgentIds();
  if (agentIds.length === 0) {
    agentIds.push('main');
  }

  for (const id of agentIds) {
    const store = await readAuthProfiles(id);
    if (removeProfileFromStore(store, `${provider}:default`, 'api_key')) {
      await writeAuthProfiles(store, id);
    }
  }
  logger.info(`Removed API key for provider "${provider}" from OpenClaw auth-profiles (agents: ${agentIds.join(', ')})`);
}
