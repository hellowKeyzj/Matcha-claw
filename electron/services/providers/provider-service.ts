import {
  PROVIDER_DEFINITIONS,
  getProviderDefinition,
} from '../../shared/providers/registry';
import type {
  ProviderAccount,
  ProviderConfig,
  ProviderDefinition,
} from '../../shared/providers/types';
import { ensureProviderStoreMigrated } from './provider-migration';
import {
  getDefaultProviderAccountId,
  getProviderAccount,
  listProviderAccounts,
  providerAccountToConfig,
  providerConfigToAccount,
  saveProviderAccount,
  setDefaultProviderAccount,
} from './provider-store';
import {
  deleteApiKey,
  deleteProvider,
  getAllProviders,
  getAllProvidersWithKeyInfo,
  getApiKey,
  getDefaultProvider,
  getProvider,
  hasApiKey,
  saveProvider,
  setDefaultProvider,
  storeApiKey,
} from '../../utils/secure-storage';
import type { ProviderWithKeyInfo } from '../../shared/providers/types';

export class ProviderService {
  async listVendors(): Promise<ProviderDefinition[]> {
    return PROVIDER_DEFINITIONS;
  }

  async listAccounts(): Promise<ProviderAccount[]> {
    await ensureProviderStoreMigrated();
    return listProviderAccounts();
  }

  async getAccount(accountId: string): Promise<ProviderAccount | null> {
    await ensureProviderStoreMigrated();
    return getProviderAccount(accountId);
  }

  async getDefaultAccountId(): Promise<string | undefined> {
    await ensureProviderStoreMigrated();
    return (await getDefaultProvider()) ?? getDefaultProviderAccountId();
  }

  async createAccount(account: ProviderAccount, apiKey?: string): Promise<ProviderAccount> {
    await ensureProviderStoreMigrated();
    await saveProvider(providerAccountToConfig(account));
    await saveProviderAccount(account);
    if (apiKey !== undefined && apiKey.trim()) {
      await storeApiKey(account.id, apiKey.trim());
    }
    return (await getProviderAccount(account.id)) ?? account;
  }

  async updateAccount(
    accountId: string,
    patch: Partial<ProviderAccount>,
    apiKey?: string,
  ): Promise<ProviderAccount> {
    await ensureProviderStoreMigrated();
    const existing = await getProviderAccount(accountId);
    if (!existing) {
      throw new Error('Provider account not found');
    }

    const nextAccount: ProviderAccount = {
      ...existing,
      ...patch,
      id: accountId,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };

    await saveProvider(providerAccountToConfig(nextAccount));
    await saveProviderAccount(nextAccount);
    if (apiKey !== undefined) {
      const trimmedKey = apiKey.trim();
      if (trimmedKey) {
        await storeApiKey(accountId, trimmedKey);
      } else {
        await deleteApiKey(accountId);
      }
    }

    return (await getProviderAccount(accountId)) ?? nextAccount;
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    await ensureProviderStoreMigrated();
    return deleteProvider(accountId);
  }

  async syncLegacyProvider(config: ProviderConfig, options?: { isDefault?: boolean }): Promise<ProviderAccount> {
    await ensureProviderStoreMigrated();
    const account = providerConfigToAccount(config, options);
    await saveProviderAccount(account);
    return account;
  }

  async listLegacyProviders(): Promise<ProviderConfig[]> {
    return getAllProviders();
  }

  async listLegacyProvidersWithKeyInfo(): Promise<ProviderWithKeyInfo[]> {
    return getAllProvidersWithKeyInfo();
  }

  async getLegacyProvider(providerId: string): Promise<ProviderConfig | null> {
    return getProvider(providerId);
  }

  async saveLegacyProvider(config: ProviderConfig): Promise<void> {
    await saveProvider(config);
  }

  async deleteLegacyProvider(providerId: string): Promise<boolean> {
    return deleteProvider(providerId);
  }

  async setDefaultLegacyProvider(providerId: string): Promise<void> {
    await setDefaultProvider(providerId);
  }

  async getDefaultLegacyProvider(): Promise<string | undefined> {
    return getDefaultProvider();
  }

  async setLegacyProviderApiKey(providerId: string, apiKey: string): Promise<boolean> {
    return storeApiKey(providerId, apiKey);
  }

  async getLegacyProviderApiKey(providerId: string): Promise<string | null> {
    return getApiKey(providerId);
  }

  async deleteLegacyProviderApiKey(providerId: string): Promise<boolean> {
    return deleteApiKey(providerId);
  }

  async hasLegacyProviderApiKey(providerId: string): Promise<boolean> {
    return hasApiKey(providerId);
  }

  async setDefaultAccount(accountId: string): Promise<void> {
    await ensureProviderStoreMigrated();
    await setDefaultProviderAccount(accountId);
    await setDefaultProvider(accountId);
  }

  getVendorDefinition(vendorId: string): ProviderDefinition | undefined {
    return getProviderDefinition(vendorId);
  }
}

const providerService = new ProviderService();

export function getProviderService(): ProviderService {
  return providerService;
}
