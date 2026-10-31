import { readFile } from 'node:fs/promises';
import { safeStorage } from 'electron';
import { MAX_AUTH_PROFILES_BYTES, isId, isProviderName, isRecord, isSecret, type AuthMode } from './account-intent';
import { isVersionedProviderCredentialReference, ownsCredentialReference } from './account-transactions';
import { readStore, removeCredentialReference, storeSecret } from './credentials';
import { applyPrivateProfile, openClawProviderKey } from './openclaw/auth-profile';
import { AuthProfileSqliteWriter } from './openclaw/auth-profile-sqlite';

export async function migrateLegacyProviderPrivateAuth(legacyProviderStoreFilePath: string, openClawStateDir: string): Promise<void> {
  const filePath = legacyProviderStoreFilePath.trim();
  if (!filePath || !safeStorage.isEncryptionAvailable()) return;
  const legacy = await readLegacyProviderStore(filePath);
  if (!legacy) return;
  let authProfiles: AuthProfileSqliteWriter;
  try { authProfiles = await AuthProfileSqliteWriter.start(openClawStateDir); }
  catch { return; }
  try {
    for (const [accountId, account] of Object.entries(legacy.accounts)) {
      const provider = storedAccountProvider(account);
      const authMode = storedAccountAuthMode(account);
      if (!isId(accountId) || !provider || !authMode || authMode === 'local' || authMode === 'cliReuse') continue;
      const reference = credentialReference(accountId);
      const store = await readStore();
      if (Object.keys(store).some((key) => isVersionedProviderCredentialReference(key) && ownsCredentialReference(accountId, key))) continue;
      const existing = store[reference];
      const key = legacy.apiKeys[accountId];
      if (!existing && (authMode !== 'apiKey' || !isSecret(key))) continue;
      try {
        if (!existing) await storeSecret(reference, { kind: 'apiKey', provider, key });
        await applyPrivateProfile(reference, accountId, openClawProviderKey(provider, accountId, authMode), provider, authMode, authProfiles);
      } catch {
        if (!existing) await removeCredentialReference(reference).catch(() => undefined);
      }
    }
  } finally {
    await authProfiles.close().catch(() => undefined);
  }
}

async function readLegacyProviderStore(path: string): Promise<{
  accounts: Record<string, Record<string, unknown>>;
  apiKeys: Record<string, string>;
} | null> {
  try {
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > MAX_AUTH_PROFILES_BYTES) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    const accounts = Array.isArray(value.accounts)
      ? Object.fromEntries(
        value.accounts
          .filter(isRecord)
          .filter((account): account is Record<string, unknown> & { id: string } => isId(account.id))
          .map((account) => [account.id, account]),
      )
      : Object.fromEntries(
        Object.entries(isRecord(value.accounts) ? value.accounts : {})
          .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
      );
    return {
      accounts,
      apiKeys: Object.fromEntries(
        Object.entries(isRecord(value.apiKeys) ? value.apiKeys : {})
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
    };
  } catch {
    return null;
  }
}

function storedAccountProvider(account: Record<string, unknown>): string | undefined {
  const provider = typeof account.provider === 'string'
    ? account.provider.replace(/^provider:/, '')
    : account.vendorId;
  return isProviderName(provider) ? provider : undefined;
}

function storedAccountAuthMode(account: Record<string, unknown>): Exclude<AuthMode, 'local'> | 'local' | undefined {
  const mode = account.authMode ?? account.auth_mode;
  if (mode === 'apiKey' || mode === 'api_key') return 'apiKey';
  if (mode === 'oauthBrowser' || mode === 'oauth_browser') return 'oauthBrowser';
  if (mode === 'oauthDevice' || mode === 'oauth_device') return 'oauthDevice';
  if (mode === 'local') return 'local';
  return undefined;
}

function credentialReference(accountId: string): string {
  return `credential:v1:${accountId}`;
}
