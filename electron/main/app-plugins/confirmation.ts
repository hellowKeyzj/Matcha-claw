import { randomUUID } from 'node:crypto';
import { AppConfirmationUnavailableError, isAppConfirmationRequest, type AppConfirmationRequest } from '../../../src/types/desktop/app-plugin-sdk';

export interface AppPluginConfirmationEvent {
  readonly ownerId: string;
  readonly requestId: string;
  readonly pluginId: string;
  readonly digest: string;
  readonly pluginName: string;
  readonly request?: AppConfirmationRequest;
}

/** Ephemeral human decisions, never tokens or reusable business approvals. */
export class AppPluginConfirmations {
  private readonly owners = new Map<string, { pluginId: string; digest: string }>();
  private readonly pending = new Map<string, { ownerId: string; pluginId: string; digest: string; finish(allowed: boolean, error?: Error): void }>();

  constructor(private readonly publish: (event: AppPluginConfirmationEvent) => void) {}

  setOwner(ownerId: string, pluginId: string, digest: string, active: boolean): void {
    this.removeOwner(ownerId);
    if (active) this.owners.set(ownerId, { pluginId, digest });
  }

  removeOwner(ownerId: string): void {
    this.owners.delete(ownerId);
    for (const pending of this.pending.values()) if (pending.ownerId === ownerId) pending.finish(false, new AppConfirmationUnavailableError('Approval unavailable: the foreground application changed.'));
  }

  async request(pluginId: string, digest: string, pluginName: string, request: AppConfirmationRequest, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (!isAppConfirmationRequest(request)) throw new Error('Invalid confirmation request.');
    const owners = [...this.owners].filter(([, owner]) => owner.pluginId === pluginId && owner.digest === digest);
    if (owners.length !== 1) throw new AppConfirmationUnavailableError('Approval unavailable: open one foreground application view before requesting confirmation.');
    const ownerId = owners[0][0];
    if ([...this.pending.values()].some((pending) => pending.ownerId === ownerId)) throw new AppConfirmationUnavailableError('Approval unavailable: another confirmation is already pending.');
    const requestId = randomUUID();
    const event = { ownerId, requestId, pluginId, digest, pluginName };
    return new Promise<boolean>((resolve, reject) => {
      const abort = () => finish(false, new Error('Confirmation cancelled: the tool call is no longer active.'));
      const finish = (allowed: boolean, error?: Error) => {
        if (!this.pending.delete(requestId)) return;
        signal.removeEventListener('abort', abort);
        this.publish(event);
        if (error) reject(error); else resolve(allowed);
      };
      this.pending.set(requestId, { ownerId, pluginId, digest, finish });
      signal.addEventListener('abort', abort, { once: true });
      this.publish({ ...event, request: structuredClone(request) });
    });
  }

  decide(ownerId: string, requestId: string, allowed: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.ownerId !== ownerId || !this.owners.has(ownerId)) return false;
    pending.finish(allowed);
    return true;
  }

  invalidate(pluginId: string, digest: string): void {
    for (const pending of this.pending.values()) if (pending.pluginId === pluginId && pending.digest === digest) pending.finish(false, new Error('Confirmation cancelled: the application version changed.'));
  }

  clear(): void {
    for (const ownerId of this.owners.keys()) this.removeOwner(ownerId);
  }
}
