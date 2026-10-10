import { hostApiFetch } from '@/lib/host-api';
import { AppError } from '@/lib/error-model';
import { waitForCall } from '@/lib/call-log-await';
import { decodeCallReceipt } from '@/types/call-log/receipt';
import {
  decodeRuntimeRepairSnapshot,
  type RuntimeRepairFailure,
  type RuntimeRepairSnapshot,
} from '@/types/runtime-repair';

export type GatewayRepairOutcome = 'succeeded' | 'rejected' | 'unknown' | RuntimeRepairFailure;

export function isGatewayRepairActive(snapshot: RuntimeRepairSnapshot | null): boolean {
  return snapshot !== null && ['stopping', 'repairing', 'preparing', 'starting'].includes(snapshot.phase);
}

export async function fetchGatewayRepair(signal: AbortSignal): Promise<RuntimeRepairSnapshot> {
  const snapshot = decodeRuntimeRepairSnapshot(await hostApiFetch<unknown>('/api/gateway/repair', { signal }));
  if (!snapshot) throw new Error('Invalid Gateway repair snapshot');
  return snapshot;
}

export async function runGatewayRepair(): Promise<GatewayRepairOutcome> {
  const controller = new AbortController();
  // Observation only: allow the 300s doctor and 600s readiness budgets plus stop/preparation.
  const timeout = setTimeout(() => controller.abort(), 20 * 60_000);
  try {
    const receipt = decodeCallReceipt(await hostApiFetch<unknown>('/api/gateway/repair', {
      method: 'POST',
      signal: controller.signal,
    }));
    const call = await waitForCall(receipt, 'runtime-control', { signal: controller.signal });
    const { detail } = call;
    if (call.command !== 'lifecycle.repair'
      || detail.endpoint?.kind !== 'native-runtime'
      || detail.endpoint.runtimeAdapterId !== 'openclaw'
      || detail.endpoint.runtimeInstanceId !== 'local') return 'unknown';
    if (call.status === 'unknown' || detail.result === 'unknown') return 'unknown';
    if (call.status === 'rejected') return 'rejected';
    const repair = detail.repair;
    if (!repair || repair.trigger !== 'manual') return 'unknown';
    if (call.status === 'succeeded' && detail.result === 'succeeded'
      && detail.lifecycle === 'running' && detail.failure === null && detail.error === null
      && repair.phase === 'succeeded' && repair.failure === null) return 'succeeded';
    if (call.status === 'failed' && repair.phase === 'failed' && repair.failure !== null) {
      return repair.failure;
    }
    return 'unknown';
  } catch (error) {
    if (error instanceof AppError && error.details?.status === 409
      && error.details.method === 'POST' && error.details.path === '/api/gateway/repair') return 'rejected';
    // A lost receipt, timeout or interrupted observation does not prove execution failed.
    return 'unknown';
  } finally {
    clearTimeout(timeout);
  }
}
