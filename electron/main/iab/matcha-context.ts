import { isAbsolute } from 'node:path';
import { buildSessionIdentityKey, type SessionIdentity } from '../../../src/types/desktop/runtime-address';
import {
  isIabInvocationId, isIabMatchaCapability, type IabMatchaCapability,
  type RuntimeHostControlCommand, type RuntimeHostJsonValue,
} from '../runtime-host-delivery/control';
import type { RuntimeHostLifecycle } from '../runtime-host-delivery/lifecycle-owner';
import type { IabTrustedContext } from './contracts';
import type { IabMatchaRuns } from './matcha-run';

export type { IabMatchaCapability } from '../runtime-host-delivery/control';

type Failure = 'INVALID' | 'CANCELLED' | 'DISCONNECTED' | 'ACQUIRE_FAILED' | 'WAIT_FAILED' | 'RELEASE_FAILED' | 'PROTOCOL' | 'REVOKED' | 'RELEASED';
const messages: Record<Failure, string> = {
  INVALID: 'A private Matcha browser capability and invocation are required',
  CANCELLED: 'Matcha browser invocation was cancelled',
  DISCONNECTED: 'Matcha browser lease lost its Runtime Host connection',
  ACQUIRE_FAILED: 'Matcha browser ownership could not be acquired',
  WAIT_FAILED: 'Matcha browser lease could no longer be verified',
  RELEASE_FAILED: 'Matcha browser invocation cleanup could not be confirmed',
  PROTOCOL: 'Matcha browser lease returned an invalid receipt',
  REVOKED: 'The native Matcha browser lease is no longer current',
  RELEASED: 'The Matcha browser invocation has already been released',
};
class LeaseError extends Error {
  readonly code: string;
  constructor(kind: Failure) {
    super(messages[kind]);
    this.code = `IAB_LEASE_${kind}`;
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const reasons = new Set(['instance_closing', 'instance_replaced', 'native_exit', 'native_identity_changed', 'server_shutdown']);

type Acquired = { leaseId: string; agentId: string; sessionId: string; workspaceDir: string; runId: string };
function acquired(value: RuntimeHostJsonValue, invocationId: string, capability: IabMatchaCapability): Acquired {
  if (!record(value) || Object.keys(value).length !== 7
    || !isIabInvocationId(value.leaseId) || !isIabInvocationId(value.runId) || value.invocationId !== invocationId
    || value.sessionId !== capability.sessionId || value.instanceId !== capability.instanceId
    || typeof value.agentId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.agentId)
    || typeof value.workspaceDir !== 'string' || value.workspaceDir.includes('\0') || !isAbsolute(value.workspaceDir)) {
    throw new LeaseError('PROTOCOL');
  }
  return { leaseId: value.leaseId, agentId: value.agentId, sessionId: capability.sessionId, workspaceDir: value.workspaceDir, runId: value.runId };
}

export async function acquireIabMatchaContext(input: {
  capability: IabMatchaCapability;
  invocationId: string;
  inputMessageId: string;
  runtime: Pick<RuntimeHostLifecycle, 'command' | 'onDisconnect'>;
  runs: IabMatchaRuns;
  signal: AbortSignal;
}): Promise<{ context: IabTrustedContext; signal: AbortSignal; release(): Promise<void> }> {
  const { capability, invocationId, inputMessageId, runtime, runs, signal } = input;
  if (!isIabMatchaCapability(capability) || !isIabInvocationId(invocationId) || !isIabInvocationId(inputMessageId)) throw new LeaseError('INVALID');
  if (signal.aborted) throw new LeaseError('CANCELLED');
  const controller = new AbortController();
  let active = true;
  let disconnected = false;
  let started = false;
  let leaseId: string | undefined;
  let watching: Promise<void> | undefined;
  let releasing: Promise<void> | undefined;
  let run: { signal: AbortSignal; assertCurrent(): void } | undefined;
  let acquiring: Promise<IabTrustedContext> | undefined;
  let released!: () => void;
  let releaseFailed!: (error: unknown) => void;
  const releaseReceipt = new Promise<void>((resolve, reject) => { released = resolve; releaseFailed = reject; });
  void releaseReceipt.catch(() => {});

  function invalidate(error: LeaseError): void {
    active = false;
    controller.abort(error);
  }
  // DirectRuntimeHost closes control before stop/exit can publish a replacement.
  // This flag is sticky: no cleanup command can follow the lifecycle onto a new Host.
  const stopDisconnect = runtime.onDisconnect(() => {
    disconnected = true;
    invalidate(new LeaseError('DISCONNECTED'));
  });
  const cancel = () => invalidate(new LeaseError('CANCELLED'));
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();

  function detach(): void {
    stopDisconnect();
    signal.removeEventListener('abort', cancel);
  }
  function assertCurrent(): void {
    if (!active || controller.signal.aborted) throw controller.signal.reason ?? new LeaseError('RELEASED');
    run?.assertCurrent();
  }
  async function command(command: RuntimeHostControlCommand, timeoutMs: number, failed: Failure): Promise<RuntimeHostJsonValue> {
    if (disconnected) throw new LeaseError('DISCONNECTED');
    try {
      const outcome = await runtime.command(command, { timeoutMs });
      if (disconnected) throw new LeaseError('DISCONNECTED');
      if (outcome.kind !== 'succeeded') throw new LeaseError(failed);
      return outcome.result;
    } catch {
      throw new LeaseError(disconnected ? 'DISCONNECTED' : failed);
    }
  }
  async function watch(id: string): Promise<void> {
    try {
      while (active) {
        // Native wait returns current after 20s; the control timeout also bounds teardown.
        const value = await command({ name: 'iab.lease.wait', input: { leaseId: id, invocationId } }, 25_000, 'WAIT_FAILED');
        if (!active) return;
        if (!record(value) || value.leaseId !== id || value.invocationId !== invocationId
          || !(value.state === 'current' && Object.keys(value).length === 3
            || value.state === 'revoked' && Object.keys(value).length === 4 && typeof value.reason === 'string' && reasons.has(value.reason))) {
          throw new LeaseError('PROTOCOL');
        }
        if (value.state === 'revoked') {
          invalidate(new LeaseError('REVOKED'));
          return;
        }
      }
    } catch (error) {
      if (active) invalidate(error instanceof LeaseError ? error : new LeaseError('WAIT_FAILED'));
    }
  }
  // The bridge calls this only after automation and its broker effects have settled.
  function release(): Promise<void> {
    return releasing ??= (async () => {
      invalidate(new LeaseError('RELEASED'));
      try {
        try {
          const value = await command({
            name: 'iab.lease.release',
            input: { invocationId, ...(leaseId === undefined ? {} : { leaseId }), drained: true },
          }, 5_000, 'RELEASE_FAILED');
          if (!record(value) || Object.keys(value).length !== 3 || value.invocationId !== invocationId || value.released !== true
            || !(value.leaseId === null || isIabInvocationId(value.leaseId))
            || leaseId !== undefined && value.leaseId !== leaseId) throw new LeaseError('RELEASE_FAILED');
        } finally {
          await acquiring?.catch(() => {});
          await watching;
        }
        if (disconnected) throw new LeaseError('DISCONNECTED');
        released();
      } catch (error) {
        releaseFailed(error);
        throw error;
      } finally {
        detach();
      }
    })();
  }

  let stopAcquiring = () => {};
  try {
    assertCurrent();
    const cancelled = new Promise<never>((_, reject) => {
      const abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
      stopAcquiring = () => controller.signal.removeEventListener('abort', abort);
    });
    started = true;
    acquiring = command({ name: 'iab.lease.acquire', input: { capability, invocationId, inputMessageId } }, 30_000, 'ACQUIRE_FAILED')
      .then(async (value): Promise<IabTrustedContext> => {
        const receipt = acquired(value, invocationId, capability);
        leaseId = receipt.leaseId;
        const sessionKey = `matcha-agent:${receipt.agentId}:${receipt.sessionId}`;
        const identity: SessionIdentity = Object.freeze({
          endpoint: Object.freeze({ kind: 'native-runtime' as const, runtimeAdapterId: 'matcha-agent', runtimeInstanceId: 'local' }),
          agentId: receipt.agentId,
          sessionKey,
        });
        const principalId = buildSessionIdentityKey(identity);
        watching = watch(receipt.leaseId);
        // Register independently of caller cancellation: an unknown subscription ACK
        // must retain its run owner, fixed connection and cleanup barrier.
        run = await runs.admit({ ...receipt, instanceId: capability.instanceId, executorId: principalId, principalId }, runtime, releaseReceipt);
        return Object.freeze({ principalId, executorId: principalId, identity, sessionKey, workspaceDir: receipt.workspaceDir, assertCurrent });
      });
    // Release's invocation tombstone fences a late acquire; its receipt remains observed
    // until run subscription has settled, even if the HTTP caller already cancelled.
    const context = await Promise.race([acquiring, cancelled]);
    assertCurrent();
    return { context, signal: AbortSignal.any([controller.signal, run!.signal]), release };
  } catch (error) {
    const failure = controller.signal.aborted ? controller.signal.reason
      : error instanceof LeaseError ? error : new LeaseError('ACQUIRE_FAILED');
    invalidate(failure);
    if (started) await release();
    else detach();
    throw failure;
  } finally {
    stopAcquiring();
  }
}
