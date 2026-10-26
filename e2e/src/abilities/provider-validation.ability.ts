import { Ability } from '@serenity-js/core';
import { randomUUID } from 'node:crypto';
import { UseElectron } from './use-electron.ability.js';

const publicAccountFields = new Set([
  'id', 'provider', 'label', 'enabled', 'kind', 'endpoint', 'protocol', 'mediaProtocol', 'authMode', 'revision',
]);
type PublicRow = Record<string, unknown>;

export class ProviderValidation extends Ability {
  readonly label = `e2e-provider-validation-${randomUUID()}`;
  readonly modelId = `e2e-provider-validation-model-${randomUUID()}`;
  private accountsBefore: PublicRow[] = [];
  private modelsBefore: PublicRow[] = [];
  private accountId?: string;
  private submitted = false;
  private deletionSubmitted = false;

  constructor(private readonly electron: UseElectron) { super(); }

  async prepare() {
    this.accountsBefore = await this.read('/api/provider-accounts', 'accounts');
    this.modelsBefore = await this.read('/api/provider-models', 'models');
    return { label: this.label, modelId: this.modelId, publicFieldsOnly: this.hasOnlyPublicAccountFields(this.accountsBefore) };
  }

  markSubmitted(): void {
    if (this.submitted) throw new Error('The local provider account must not be submitted twice');
    this.submitted = true;
  }

  markDeletionSubmitted(): void {
    if (!this.accountId || this.deletionSubmitted) throw new Error('Only one deletion of the confirmed provider UUID is allowed');
    this.deletionSubmitted = true;
  }

  async observeEmptyKeyRejection() {
    const accounts = await this.read('/api/provider-accounts', 'accounts');
    return {
      unchanged: JSON.stringify(accounts) === JSON.stringify(this.accountsBefore),
      publicFieldsOnly: this.hasOnlyPublicAccountFields(accounts),
    };
  }

  async confirmAccount() {
    const accounts = await this.read('/api/provider-accounts', 'accounts');
    const account = this.findOwnedAccount(accounts);
    if (!account || !this.accountId) throw new Error('The unique local provider account was not committed');
    const reply = await this.electron.fetchHostApi({
      path: `/api/provider-accounts/${encodeURIComponent(this.accountId)}/has-api-key`, method: 'GET',
    });
    const status = reply.ok ? reply.data.json : undefined;
    return {
      provider: account.provider, authMode: account.authMode, enabled: account.enabled,
      publicFieldsOnly: this.hasOnlyPublicAccountFields(accounts),
      credentialStatusOnly: reply.ok && reply.data.status === 200 && reply.data.ok
        && status !== null && typeof status === 'object' && Object.keys(status).length === 1
        && 'hasKey' in status && typeof status.hasKey === 'boolean',
      hasNoStoredKey: status !== null && typeof status === 'object' && 'hasKey' in status && status.hasKey === false,
    };
  }

  async observeModel() {
    if (!this.accountId) throw new Error('The local provider account identity was not confirmed');
    const models = await this.read('/api/provider-models', 'models');
    const owned = models.filter(model => model.accountId === this.accountId);
    return {
      count: owned.length,
      modelMatches: owned[0]?.modelId === this.modelId,
      chatOnly: JSON.stringify(owned[0]?.capabilities) === JSON.stringify(['chat']),
      otherModelsUnchanged: JSON.stringify(models.filter(model => model.accountId !== this.accountId)) === JSON.stringify(this.modelsBefore),
    };
  }

  async findCleanupTarget(): Promise<boolean> {
    const account = this.findOwnedAccount(await this.read('/api/provider-accounts', 'accounts'));
    if (!account && this.submitted && !this.accountId) {
      throw new Error('Provider submission outcome is unconfirmed; no mutation was repeated and no existing account was deleted');
    }
    return account !== undefined;
  }

  async confirmRestored(): Promise<boolean> {
    const accounts = await this.read('/api/provider-accounts', 'accounts');
    const models = await this.read('/api/provider-models', 'models');
    return JSON.stringify(accounts) === JSON.stringify(this.accountsBefore)
      && JSON.stringify(models) === JSON.stringify(this.modelsBefore);
  }

  private findOwnedAccount(accounts: PublicRow[]): PublicRow | undefined {
    const matches = accounts.filter(account => account.label === this.label);
    if (matches.length === 0) return undefined;
    const account = matches[0]!;
    if (matches.length !== 1 || account.provider !== 'ollama' || account.authMode !== 'local'
      || account.kind !== 'chat' || typeof account.id !== 'string'
      || !/^ollama-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(account.id)
      || this.accountsBefore.some(previous => previous.id === account.id)
      || (this.accountId !== undefined && account.id !== this.accountId)) {
      throw new Error('The cleanup target does not match this case\'s unique local provider identity');
    }
    this.accountId = account.id;
    return account;
  }

  private hasOnlyPublicAccountFields(accounts: PublicRow[]): boolean {
    return accounts.every(account => Object.keys(account).every(field => publicAccountFields.has(field)));
  }

  private async read(path: string, field: 'accounts' | 'models'): Promise<PublicRow[]> {
    const reply = await this.electron.fetchHostApi({ path, method: 'GET' });
    if (!reply.ok || reply.data.status !== 200 || !reply.data.ok) {
      throw new Error(`Public provider ${field} is unavailable (${reply.ok ? reply.data.status : reply.error.code})`);
    }
    const body = reply.data.json;
    if (body === null || typeof body !== 'object' || !(field in body)) {
      throw new Error(`Public provider ${field} response has no catalog`);
    }
    const rows: unknown = (body as Record<string, unknown>)[field];
    if (!Array.isArray(rows) || rows.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error(`Public provider ${field} catalog is invalid`);
    }
    return rows as PublicRow[];
  }
}
