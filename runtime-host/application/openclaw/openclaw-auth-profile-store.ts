import { isOAuthProviderType } from '../providers/provider-runtime-rules';
import {
  discoverAgentIds,
  readAuthProfiles,
  type OAuthProfileEntry,
  writeAuthProfiles,
} from './openclaw-auth-store';

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
  console.log(`Saved OAuth token for provider "${provider}" to OpenClaw auth-profiles (agents: ${agentIds.join(', ')})`);
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
    console.warn(`[getOAuthToken] Failed to read token for ${provider}:`, error);
  }
  return null;
}

export async function saveProviderKeyToOpenClaw(
  provider: string,
  apiKey: string,
  agentId?: string,
): Promise<void> {
  if (isOAuthProviderType(provider) && !apiKey) {
    console.log(`Skipping auth-profiles write for OAuth provider "${provider}" (no API key provided, using OAuth)`);
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
  console.log(`Saved API key for provider "${provider}" to OpenClaw auth-profiles (agents: ${agentIds.join(', ')})`);
}

export async function removeProviderKeyFromOpenClaw(
  provider: string,
  agentId?: string,
): Promise<void> {
  if (isOAuthProviderType(provider)) {
    console.log(`Skipping auth-profiles removal for OAuth provider "${provider}" (managed by OpenClaw plugin)`);
    return;
  }

  const agentIds = agentId ? [agentId] : await discoverAgentIds();
  if (agentIds.length === 0) {
    agentIds.push('main');
  }

  for (const id of agentIds) {
    const store = await readAuthProfiles(id);
    const profileId = `${provider}:default`;

    delete store.profiles[profileId];

    if (store.order?.[provider]) {
      store.order[provider] = store.order[provider].filter((entryId) => entryId !== profileId);
      if (store.order[provider].length === 0) {
        delete store.order[provider];
      }
    }
    if (store.lastGood?.[provider] === profileId) {
      delete store.lastGood[provider];
    }

    await writeAuthProfiles(store, id);
  }
  console.log(`Removed API key for provider "${provider}" from OpenClaw auth-profiles (agents: ${agentIds.join(', ')})`);
}
