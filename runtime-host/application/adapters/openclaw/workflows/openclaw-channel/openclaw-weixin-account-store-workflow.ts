import { join } from 'node:path';
import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { ChannelLoginRuntimePort } from '../../channels/channel-login-session-service';

export interface OpenClawWeixinAccountStoreWorkflowDeps {
  readonly fileSystem: Pick<RuntimeFileSystemPort, 'ensureDirectory' | 'readTextFile' | 'writeTextFile' | 'removeFile'>;
  readonly runtime: Pick<ChannelLoginRuntimePort, 'getEnv' | 'getRuntimeDataRootDir'>;
}

export interface SaveOpenClawWeixinAccountParams {
  readonly normalizedAccountId: string;
  readonly token: string;
  readonly baseUrl: string;
  readonly userId?: string;
}

export class OpenClawWeixinAccountStoreWorkflow {
  constructor(private readonly deps: OpenClawWeixinAccountStoreWorkflowDeps) {}

  async saveAccount(params: SaveOpenClawWeixinAccountParams): Promise<{ staleAccountIds: string[] }> {
    const stateDir = this.resolveStateDir();
    const accountsDir = this.resolveAccountsDir();
    await this.deps.fileSystem.ensureDirectory(stateDir);
    await this.deps.fileSystem.ensureDirectory(accountsDir);

    const existingIds = await this.readJsonStringArray(this.resolveAccountsIndexPath());
    const userId = params.userId?.trim();
    const staleAccountIds = userId
      ? (await Promise.all(existingIds.map(async (accountId) => ({
        accountId,
        userId: await this.readAccountUserId(accountId),
      })))).filter((item) => (
        item.accountId !== params.normalizedAccountId
        && item.userId === userId
      )).map((item) => item.accountId)
      : [];

    await this.writeAccount(params, userId);
    for (const accountId of staleAccountIds) {
      await this.removeAccountFiles(accountId);
    }

    const staleSet = new Set(staleAccountIds);
    const updatedIds = [
      ...existingIds.filter((accountId) => accountId !== params.normalizedAccountId && !staleSet.has(accountId)),
      params.normalizedAccountId,
    ];
    await this.deps.fileSystem.writeTextFile(this.resolveAccountsIndexPath(), `${JSON.stringify(updatedIds, null, 2)}\n`);
    return { staleAccountIds };
  }

  private resolveStateDir(): string {
    return join(
      this.deps.runtime.getEnv('OPENCLAW_STATE_DIR')
        || this.deps.runtime.getEnv('CLAWDBOT_STATE_DIR')
        || this.deps.runtime.getRuntimeDataRootDir(),
      'openclaw-weixin',
    );
  }

  private resolveAccountsDir(): string {
    return join(this.resolveStateDir(), 'accounts');
  }

  private resolveAccountsIndexPath(): string {
    return join(this.resolveStateDir(), 'accounts.json');
  }

  private async readJsonStringArray(pathname: string): Promise<string[]> {
    try {
      const parsed = JSON.parse(await this.deps.fileSystem.readTextFile(pathname));
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
    } catch {
      return [];
    }
  }

  private async readAccountUserId(accountId: string): Promise<string | undefined> {
    try {
      const raw = await this.deps.fileSystem.readTextFile(join(this.resolveAccountsDir(), `${accountId}.json`));
      const parsed = JSON.parse(raw);
      return isRecord(parsed) && typeof parsed.userId === 'string'
        ? parsed.userId.trim() || undefined
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeAccount(params: SaveOpenClawWeixinAccountParams, userId: string | undefined): Promise<void> {
    await this.deps.fileSystem.writeTextFile(join(this.resolveAccountsDir(), `${params.normalizedAccountId}.json`), `${JSON.stringify({
      token: params.token,
      baseUrl: params.baseUrl,
      savedAt: new Date().toISOString(),
      ...(userId ? { userId } : {}),
    }, null, 2)}\n`);
  }

  private async removeAccountFiles(accountId: string): Promise<void> {
    const accountsDir = this.resolveAccountsDir();
    await Promise.all([
      this.deps.fileSystem.removeFile(join(accountsDir, `${accountId}.json`)),
      this.deps.fileSystem.removeFile(join(accountsDir, `${accountId}.sync.json`)),
      this.deps.fileSystem.removeFile(join(accountsDir, `${accountId}.context-tokens.json`)),
    ]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
