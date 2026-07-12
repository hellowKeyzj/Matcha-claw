import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { RemoteFleetRuntimeIdentityPort } from '../remote-fleet-runtime';

export class NodeRemoteFleetRuntimeIdentity implements RemoteFleetRuntimeIdentityPort {
  randomId(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }

  randomToken(byteLength: number): string {
    return randomBytes(byteLength).toString('hex');
  }

  async hashSecret(secret: string): Promise<string> {
    return createHash('sha256').update(secret).digest('hex');
  }
}
