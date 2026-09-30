import { hostApiFetch } from './host-api';
import { waitForCall } from './call-log-await';
import type { CallReceipt } from '@/types/call-log';
import type { PluginCallOutcome } from '@/types/call-log/plugins';
import { isCallId } from '@/types/call-log/decode';

export async function configurePlugin(pluginId: string, enabled: boolean): Promise<PluginCallOutcome> {
  return mutate('/api/plugins/configuration', { runtime: 'openclaw', pluginId, enabled }, 'configuration');
}

export async function operatePlugin(
  pluginId: string,
  operation: 'install' | 'update' | 'uninstall',
): Promise<PluginCallOutcome> {
  return mutate('/api/plugins/operation', { runtime: 'openclaw', pluginId, operation }, 'operation');
}

async function mutate(
  path: string,
  input: Record<string, string | boolean>,
  kind: 'configuration' | 'operation',
): Promise<PluginCallOutcome> {
  const response = await hostApiFetch<unknown>(path, { method: 'POST', body: JSON.stringify(input) });
  if (typeof response !== 'object' || response === null || Array.isArray(response)
    || Object.keys(response).length !== 2 || !Object.hasOwn(response, 'callId')
    || !Object.hasOwn(response, 'accepted')) throw new Error('Invalid plugin admission');
  const receipt = response as Record<string, unknown>;
  if (!isCallId(receipt.callId) || receipt.accepted !== true) throw new Error('Invalid plugin admission');
  const record = await waitForCall({ callId: receipt.callId, accepted: true } satisfies CallReceipt, 'plugins');
  const detail = record.detail;
  if (detail.kind !== kind || (detail.kind !== 'configuration' && detail.kind !== 'operation')) {
    throw new Error('Invalid plugin call detail');
  }
  if ((detail.pluginId !== null && detail.pluginId !== input.pluginId)
    || (detail.kind === 'configuration' && detail.enabled !== input.enabled)
    || (detail.kind === 'operation' && detail.operation !== input.operation)) {
    throw new Error('Invalid plugin call identity');
  }
  if (record.status === 'unknown') return 'unknown';
  if (detail.outcome === null) throw new Error('Plugin terminal outcome is unavailable');
  if ((record.status === 'succeeded' && detail.outcome !== 'configured')
    || (record.status === 'rejected' && detail.outcome !== 'rejected')) {
    throw new Error('Invalid plugin terminal outcome');
  }
  return detail.outcome;
}
