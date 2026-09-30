import { hostApiFetch } from './host-api';
import { waitForCall } from './call-log-await';
import { decodeCallReceipt } from '../types/call-log/receipt';
import { decodeCronCallDetail } from '../types/call-log/cron';
import { isCronDeleteResult, isCronJob, type CronDeleteResult, type CronResultCommand } from '../types/cron-operation-result';
import type { CronJob } from '../types/cron';

export type CronMutationOperation = 'cron.create' | 'cron.update' | 'cron.delete' | 'cron.toggle';

export async function waitForCronMutation(
  value: unknown,
  operation: CronMutationOperation,
  jobId?: string,
): Promise<CronJob | CronDeleteResult> {
  const command: CronResultCommand = operation === 'cron.toggle' ? 'update'
    : operation === 'cron.create' ? 'create' : operation === 'cron.delete' ? 'delete' : 'update';
  const receipt = decodeCallReceipt(value);
  const call = await waitForCall(receipt, 'cron');
  const detail = decodeCronCallDetail(call.detail);
  if (call.command !== command || !detail
    || (command !== 'create' && (!jobId || (detail.jobId !== undefined && detail.jobId !== jobId)))) {
    throw new Error('Invalid Cron mutation call identity');
  }
  if (call.status === 'unknown') throw new Error('Cron operation outcome is unknown');
  if (call.status === 'rejected' && detail.outcome === 'rejected') throw new Error('Cron operation was rejected');
  if (call.status === 'failed' && detail.outcome === 'unavailable') throw new Error('Cron service is unavailable');
  if (call.status !== 'succeeded' || detail.outcome !== 'applied') throw new Error('Invalid Cron mutation terminal outcome');

  const result = await hostApiFetch<unknown>('/api/cron/results', {
    method: 'POST',
    body: JSON.stringify({ callId: receipt.callId, command, ...(command === 'create' ? {} : { jobId }) }),
  });
  if (command === 'delete') {
    if (!isCronDeleteResult(result) || result.removed !== detail.removed) throw new Error('Invalid cron delete response');
    return result;
  }
  if (!isCronJob(result) || (jobId !== undefined && result.id !== jobId)
    || (detail.jobId !== undefined && result.id !== detail.jobId)) {
    throw new Error(`Invalid cron ${operation === 'cron.toggle' ? 'toggle' : command} response`);
  }
  return result;
}
