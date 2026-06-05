import { join } from 'node:path';
import { normalizeSecurityPolicyPayload } from '../../security/security-policy-normalizer';
import type { SecurityPolicyPayload } from '../../security/security-policy-types';
import type { RuntimeFileSystemPort } from '../../common/runtime-ports';

export interface SecurityPolicyStoragePort {
  getRuntimeDataRootDir(): string;
}

export interface SecurityPolicyStoreWorkflowDeps {
  readonly storage: SecurityPolicyStoragePort;
  readonly fileSystem: RuntimeFileSystemPort;
}

export class SecurityPolicyStoreWorkflow {
  constructor(private readonly deps: SecurityPolicyStoreWorkflowDeps) {}

  getFilePath(): string {
    return join(this.getPolicyDir(), 'security.policy.json');
  }

  async read(): Promise<SecurityPolicyPayload> {
    const preferred = await this.readPolicyFile(this.getFilePath());
    if (preferred) {
      return preferred;
    }
    return normalizeSecurityPolicyPayload({});
  }

  async write(payload: unknown): Promise<SecurityPolicyPayload> {
    const normalized = normalizeSecurityPolicyPayload(payload);
    await this.deps.fileSystem.ensureDirectory(this.getPolicyDir());
    await this.deps.fileSystem.writeTextFile(this.getFilePath(), `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }

  private getPolicyDir(): string {
    return join(this.deps.storage.getRuntimeDataRootDir(), 'policies');
  }

  private async readPolicyFile(filePath: string): Promise<SecurityPolicyPayload | null> {
    try {
      const raw = await this.deps.fileSystem.readTextFile(filePath);
      const parsed = JSON.parse(raw);
      return normalizeSecurityPolicyPayload(parsed);
    } catch {
      return null;
    }
  }
}
