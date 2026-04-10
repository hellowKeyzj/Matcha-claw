/**
 * Provider State Store
 * Manages AI provider configurations
 */
import { create } from 'zustand';
import type {
  ProviderAccount,
  ProviderVendorInfo,
  ProviderWithKeyInfo,
} from '@/lib/providers';
import {
  fetchProviderSnapshot,
} from '@/lib/provider-accounts';
import {
  hostProviderCreateAccount,
  hostProviderDeleteAccount,
  hostProviderReadApiKey,
  hostProviderSetDefaultAccount,
  hostProviderUpdateAccount,
  hostProviderValidate,
} from '@/lib/provider-runtime';

// Re-export types for consumers that imported from here
export type {
  ProviderAccount,
  ProviderVendorInfo,
  ProviderWithKeyInfo,
} from '@/lib/providers';
export type { ProviderSnapshot } from '@/lib/provider-accounts';

interface ProviderState {
  statuses: ProviderWithKeyInfo[];
  accounts: ProviderAccount[];
  vendors: ProviderVendorInfo[];
  defaultAccountId: string | null;
  loading: boolean;
  error: string | null;
  
  // Actions
  init: () => Promise<void>;
  refreshProviderSnapshot: () => Promise<void>;
  createAccount: (account: ProviderAccount, apiKey?: string) => Promise<void>;
  updateAccount: (accountId: string, updates: Partial<ProviderAccount>, apiKey?: string) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;
  setDefaultAccount: (accountId: string) => Promise<void>;
  validateAccountApiKey: (
    accountOrVendorId: string,
    apiKey: string,
    options?: {
      baseUrl?: string;
      apiProtocol?: ProviderAccount['apiProtocol'];
      headers?: Record<string, string>;
    }
  ) => Promise<{ valid: boolean; error?: string }>;
  getAccountApiKey: (accountId: string) => Promise<string | null>;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  statuses: [],
  accounts: [],
  vendors: [],
  defaultAccountId: null,
  loading: false,
  error: null,

  init: async () => {
    await get().refreshProviderSnapshot();
  },
  
  refreshProviderSnapshot: async () => {
    set({ loading: true, error: null });
    
    try {
      const snapshot = await fetchProviderSnapshot();
      
      set({ 
        statuses: snapshot.statuses ?? [],
        accounts: snapshot.accounts ?? [],
        vendors: snapshot.vendors ?? [],
        defaultAccountId: snapshot.defaultAccountId ?? null,
        loading: false 
      });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  createAccount: async (account, apiKey) => {
    try {
      const result = await hostProviderCreateAccount(account, apiKey);

      if (!result.success) {
        throw new Error(result.error || 'Failed to create provider account');
      }

      await get().refreshProviderSnapshot();
    } catch (error) {
      console.error('Failed to add account:', error);
      throw error;
    }
  },

  updateAccount: async (accountId, updates, apiKey) => {
    try {
      const result = await hostProviderUpdateAccount(accountId, updates, apiKey);

      if (!result.success) {
        throw new Error(result.error || 'Failed to update provider account');
      }

      await get().refreshProviderSnapshot();
    } catch (error) {
      console.error('Failed to update account:', error);
      throw error;
    }
  },
  
  removeAccount: async (accountId) => {
    try {
      const result = await hostProviderDeleteAccount(accountId);

      if (!result.success) {
        throw new Error(result.error || 'Failed to delete provider account');
      }

      await get().refreshProviderSnapshot();
    } catch (error) {
      console.error('Failed to delete account:', error);
      throw error;
    }
  },

  setDefaultAccount: async (accountId) => {
    try {
      const result = await hostProviderSetDefaultAccount(accountId);

      if (!result.success) {
        throw new Error(result.error || 'Failed to set default provider account');
      }

      set({ defaultAccountId: accountId });
    } catch (error) {
      console.error('Failed to set default account:', error);
      throw error;
    }
  },
  
  validateAccountApiKey: async (accountOrVendorId, apiKey, options) => {
    try {
      const account = get().accounts.find((candidate) => candidate.id === accountOrVendorId);
      const payload = account
        ? { accountId: account.id, vendorId: account.vendorId, apiKey, options }
        : { vendorId: accountOrVendorId, apiKey, options };
      const result = await hostProviderValidate(payload);
      return result;
    } catch (error) {
      return { valid: false, error: String(error) };
    }
  },

  getAccountApiKey: async (accountId) => {
    try {
      const result = await hostProviderReadApiKey(accountId);
      return result.apiKey;
    } catch {
      return null;
    }
  },

}));
