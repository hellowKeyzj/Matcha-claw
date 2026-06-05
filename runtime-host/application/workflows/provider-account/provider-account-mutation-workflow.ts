import type { RuntimeClockPort } from '../../common/runtime-ports';
import type { CapabilityRoutingApplicationService } from '../../providers/capability-routing-service';
import { normalizeProviderAccountLocal } from '../../providers/account-runtime';
import type { ProviderModelsApplicationService } from '../../providers/provider-models-service';
import type { ProviderAccountsProjectionPort } from '../../providers/provider-accounts-projection-port';
import { isRecord } from '../../providers/provider-store-model';
import type { ProviderStorePort, ProviderStoreRecord } from '../../providers/provider-store-repository';

export interface ProviderAccountMutationWorkflowDeps {
  readonly store: ProviderStorePort;
  readonly projection: ProviderAccountsProjectionPort;
  readonly providerModels: Pick<ProviderModelsApplicationService, 'syncRuntimeProjection' | 'removeCredentialModels'>;
  readonly capabilityRouting: Pick<CapabilityRoutingApplicationService, 'removeCredentialRoutes'>;
  readonly clock: RuntimeClockPort;
}

export class ProviderAccountMutationWorkflow {
  constructor(private readonly deps: ProviderAccountMutationWorkflowDeps) {}

  async executeCreate(payload: unknown): Promise<{ success: true; account: Record<string, unknown> }> {
    const body = isRecord(payload) ? payload : {};
    const account = normalizeProviderAccountLocal(body.account, null, this.deps.clock);
    if (!account) {
      throw new Error('account 参数无效');
    }
    const store = await this.deps.store.read();
    store.accounts[account.id] = account;
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (apiKey) {
      store.apiKeys[account.id] = apiKey;
    }
    await this.deps.store.write(store);
    await this.syncStoreToProjection(store);
    await this.deps.providerModels.syncRuntimeProjection();
    return {
      success: true,
      account: store.accounts[account.id],
    };
  }

  async executeUpdate(accountId: string, payload: unknown): Promise<{ success: true; account: Record<string, unknown> }> {
    const store = await this.deps.store.read();
    const existing = isRecord(store.accounts[accountId]) ? store.accounts[accountId] : null;
    if (!existing) {
      throw new Error('Provider account not found');
    }
    const body = isRecord(payload) ? payload : {};
    const updates = isRecord(body.updates) ? body.updates : null;
    if (!updates) {
      throw new Error('updates 参数无效');
    }
    const next = normalizeProviderAccountLocal({
      ...existing,
      ...updates,
      id: accountId,
    }, existing, this.deps.clock);
    if (!next) {
      throw new Error('provider account 参数无效');
    }
    store.accounts[accountId] = next;
    if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (apiKey) {
        store.apiKeys[accountId] = apiKey;
      } else {
        delete store.apiKeys[accountId];
      }
    }
    await this.deps.store.write(store);
    await this.syncStoreToProjection(store);
    await this.deps.providerModels.syncRuntimeProjection();
    return { success: true, account: next };
  }

  async executeDelete(accountId: string, apiKeyOnly: boolean): Promise<{ success: true }> {
    const store = await this.deps.store.read();
    const existingAccount = isRecord(store.accounts[accountId]) ? store.accounts[accountId] : null;
    const cleanupProviderKeys = this.deps.projection.resolveCleanupProviderKeys({
      accountId,
      account: existingAccount,
    });

    if (apiKeyOnly) {
      delete store.apiKeys[accountId];
      for (const providerKey of cleanupProviderKeys) {
        await this.deps.projection.removeProviderKey(providerKey);
      }
      await this.deps.store.write(store);
      await this.syncStoreToProjection(store);
      return { success: true };
    }

    delete store.accounts[accountId];
    delete store.apiKeys[accountId];
    await this.deps.providerModels.removeCredentialModels(accountId);
    await this.deps.capabilityRouting.removeCredentialRoutes(accountId);
    const isCustomMediaCredential = existingAccount?.vendorId === 'custom' && existingAccount.providerKind === 'media';
    if (!isCustomMediaCredential) {
      for (const providerKey of cleanupProviderKeys) {
        await this.deps.projection.removeProviderConfig(providerKey);
      }
    }
    await this.deps.store.write(store);
    await this.syncStoreToProjection(store);
    return { success: true };
  }

  private async syncStoreToProjection(store: ProviderStoreRecord): Promise<void> {
    const result = await this.deps.projection.syncStoreToProjection(store);
    if (result.storeModified) {
      await this.deps.store.write(store);
    }
  }
}
