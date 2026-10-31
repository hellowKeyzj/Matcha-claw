import { AuthProfileSqliteWriter } from './auth-profile-sqlite';
import { type AuthMode, type CredentialAuthMode } from '../account-intent';
import { ProviderPrivateResolverError } from '../credential-error';
import { decryptPrivateCredential, readPrivateCredential, removeCredentialReference, type PrivateCredential } from '../credentials';
import { idShape, providerPrivateAuthTrace } from '../trace';

type AuthProfile = Record<string, unknown>;

export async function deletePrivateAccount(reference: string, accountId: string, profileProvider: string, authProfiles: AuthProfileSqliteWriter): Promise<void> {
  await removePrivateProfile(reference, accountId, profileProvider, authProfiles);
  await removeCredentialReference(reference);
}

export async function applyPrivateProfile(
  reference: string,
  accountId: string,
  profileProvider: string,
  credentialProvider: string,
  authMode: CredentialAuthMode,
  authProfiles: AuthProfileSqliteWriter,
): Promise<void> {
  providerPrivateAuthTrace('store.private-profile-before', () => ({
    provider: profileProvider,
    sourceProvider: credentialProvider,
    authMode,
    reference: idShape(reference),
  }));
  const encrypted = await readPrivateCredential(reference);
  const credential = decryptPrivateCredential(encrypted);
  const profileId = privateProfileId(profileProvider);
  const legacyProfileId = accountId;
  const profile = authMode === 'apiKey'
    ? credential.kind === 'apiKey' && credential.provider === credentialProvider
      ? { type: 'api_key', provider: profileProvider, key: credential.key }
      : undefined
    : authMode === 'token'
      ? credential.kind === 'token' && credential.provider === credentialProvider
        ? { type: 'token', provider: profileProvider, token: credential.token }
        : undefined
      : credential.kind === 'oauth'
        ? oauthProfile(profileProvider, credential)
        : undefined;
  if (!profile) {
    throw new ProviderPrivateResolverError(
      credential.kind === 'apiKey' ? 'credential-provider-mismatch' : 'credential-invalid',
    );
  }

  await authProfiles.update({ type: 'apply', provider: profileProvider, profileId, legacyProfileId, profile });
  providerPrivateAuthTrace('store.private-profile-after', () => ({
    provider: profileProvider,
    sourceProvider: credentialProvider,
    authMode,
    reference: idShape(reference),
    profileId: idShape(profileId),
    legacyProfileId: idShape(legacyProfileId),
  }));
}

function oauthProfile(
  provider: string,
  credential: Extract<PrivateCredential, { kind: 'oauth' }>,
): AuthProfile {
  const { kind: _, ...profile } = credential;
  return { ...profile, type: 'oauth', provider };
}

export async function removePrivateProfile(reference: string, accountId: string, profileProvider: string, authProfiles: AuthProfileSqliteWriter): Promise<void> {
  const profileId = privateProfileId(profileProvider);
  const legacyProfileId = accountId;
  providerPrivateAuthTrace('delete.private-profile-before', () => ({
    provider: profileProvider,
    reference: idShape(reference),
    profileId: idShape(profileId),
    legacyProfileId: idShape(legacyProfileId),
  }));
  await authProfiles.update({ type: 'remove', profileId, legacyProfileId });
  providerPrivateAuthTrace('delete.private-profile-after', () => ({
    provider: profileProvider,
    reference: idShape(reference),
    profileId: idShape(profileId),
    legacyProfileId: idShape(legacyProfileId),
  }));
}

export function openClawProviderKey(provider: string, providerId: string, authMode?: AuthMode): string {
  if (provider === 'openai' && authMode === 'oauthBrowser') return 'openai';
  if (provider === 'minimax-portal-cn') return 'minimax-portal';
  if (provider === 'zai-global') return 'zai';
  if (provider === 'custom' || provider === 'ollama') return multiInstanceProviderKey(provider, providerId);
  return provider;
}

function multiInstanceProviderKey(provider: string, providerId: string): string {
  if (providerId === provider) return provider;
  const prefix = `${provider}-`;
  const suffixSource = providerId.startsWith(prefix) ? providerId.slice(prefix.length) : providerId;
  const suffix = normalizeProviderKeyPart(suffixSource);
  return `${provider}-${suffix.match(/^([A-Fa-f0-9]{8})-/)?.[1] ?? suffix}`;
}

function normalizeProviderKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function privateProfileId(provider: string): string {
  return `${provider}:default`;
}
