import { join } from 'node:path';
import { normalizeSecurityPolicyPayload } from './security-policy-normalizer';
import type { SecurityPolicyPayload } from './security-policy-types';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawConfigRepositoryPort } from '../openclaw/openclaw-config-repository';

export class SecurityPolicyRepository {
  constructor(
    private readonly configRepository: OpenClawConfigRepositoryPort,
    private readonly fileSystem: RuntimeFileSystemPort,
  ) {}

  getFilePath(): string {
    return join(this.getPolicyDir(), 'security.policy.json');
  }

  async read(): Promise<SecurityPolicyPayload> {
    const preferred = await readPolicyFile(this.fileSystem, this.getFilePath());
    if (preferred) {
      return preferred;
    }
    return normalizeSecurityPolicyPayload({});
  }

  async write(payload: unknown): Promise<SecurityPolicyPayload> {
    const normalized = normalizeSecurityPolicyPayload(payload);
    await this.fileSystem.ensureDirectory(this.getPolicyDir());
    await this.fileSystem.writeTextFile(this.getFilePath(), `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }

  private getPolicyDir(): string {
    return join(this.configRepository.getConfigDir(), 'policies');
  }
}

async function readPolicyFile(
  fileSystem: RuntimeFileSystemPort,
  filePath: string,
): Promise<SecurityPolicyPayload | null> {
  try {
    const raw = await fileSystem.readTextFile(filePath);
    const parsed = JSON.parse(raw);
    return normalizeSecurityPolicyPayload(parsed);
  } catch {
    return null;
  }
}
