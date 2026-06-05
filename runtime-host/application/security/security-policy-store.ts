import type { SecurityPolicyPayload } from './security-policy-types';
import type { SecurityPolicyStoragePort, SecurityPolicyStoreWorkflow } from '../workflows/security-policy/security-policy-store-workflow';

export type { SecurityPolicyStoragePort };

export class SecurityPolicyRepository {
  constructor(
    private readonly storeWorkflow: Pick<SecurityPolicyStoreWorkflow, 'getFilePath' | 'read' | 'write'>,
  ) {}

  getFilePath(): string {
    return this.storeWorkflow.getFilePath();
  }

  async read(): Promise<SecurityPolicyPayload> {
    return await this.storeWorkflow.read();
  }

  async write(payload: unknown): Promise<SecurityPolicyPayload> {
    return await this.storeWorkflow.write(payload);
  }
}
