import { hostApiFetch, resolveSingleCapabilityScope, waitForRuntimeJobResult, type RuntimeJobSubmission } from '@/lib/host-api';
import type { ChannelType } from '@/types/channel';
import type { CapabilityTarget } from '../../runtime-host/shared/runtime-address';

const CHANNEL_INTEGRATION_CAPABILITY_ID = 'integration.channel';

async function channelIntegrationCapabilityExecute<TResult>(
  operationId: string,
  input: Record<string, unknown> = {},
  target: CapabilityTarget | null = null,
): Promise<TResult> {
  return await hostApiFetch<TResult>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: CHANNEL_INTEGRATION_CAPABILITY_ID,
      operationId,
      scope: await resolveSingleCapabilityScope(CHANNEL_INTEGRATION_CAPABILITY_ID),
      target,
      input,
    }),
  });
}

async function submitChannelCapabilityJob<TResult = unknown>(
  operationId: string,
  input: Record<string, unknown> = {},
  target: CapabilityTarget | null = null,
): Promise<TResult> {
  const submission = await channelIntegrationCapabilityExecute<RuntimeJobSubmission<TResult>>(operationId, input, target);
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export interface ChannelSnapshotFetchResult {
  success: boolean;
  snapshot?: unknown;
  ready?: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
  error?: string | null;
}

export interface ChannelPairingRequest {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
}

export async function hostChannelsFetchSnapshot(): Promise<ChannelSnapshotFetchResult> {
  return await hostApiFetch<ChannelSnapshotFetchResult>('/api/channels/snapshot');
}

export async function hostChannelsProbe(): Promise<unknown> {
  return await submitChannelCapabilityJob('channels.probe', {}, { kind: 'none' });
}

export async function hostChannelsReadConfig(
  channelType: ChannelType,
  accountId?: string,
): Promise<{ success: boolean; values?: Record<string, string> }> {
  const suffix = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
  return await hostApiFetch<{ success: boolean; values?: Record<string, string> }>(
    `/api/channels/config/${encodeURIComponent(channelType)}${suffix}`,
  );
}

export async function hostChannelsActivate(input: {
  channelType: ChannelType;
  config: Record<string, unknown>;
  accountId?: string;
}): Promise<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean }> {
  const target = { kind: 'channel' as const, channelType: input.channelType, ...(input.accountId ? { accountId: input.accountId } : {}) };
  if (input.channelType === 'whatsapp' || input.channelType === 'openclaw-weixin') {
    return await channelIntegrationCapabilityExecute<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean }>(
      'channels.activate',
      input,
      target,
    );
  }
  return await submitChannelCapabilityJob<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean }>(
    'channels.activate',
    input,
    target,
  );
}

export async function hostChannelsValidateCredentials(
  channelType: ChannelType,
  config: Record<string, string>,
): Promise<{
  success: boolean;
  valid?: boolean;
  errors?: string[];
  warnings?: string[];
  details?: Record<string, string>;
}> {
  return await hostApiFetch<{
    success: boolean;
    valid?: boolean;
    errors?: string[];
    warnings?: string[];
    details?: Record<string, string>;
  }>('/api/channels/credentials/validate', {
    method: 'POST',
    body: JSON.stringify({ channelType, config }),
  });
}

export async function hostChannelsDeleteConfig(channelType: ChannelType): Promise<unknown> {
  return await submitChannelCapabilityJob('channels.deleteConfig', { channelType }, { kind: 'channel', channelType });
}

export async function hostChannelsConnect(
  channelType: ChannelType,
  accountId?: string,
): Promise<{ success: boolean }> {
  return await channelIntegrationCapabilityExecute<{ success: boolean }>(
    'channels.connect',
    { channelType, accountId },
    { kind: 'channel', channelType, ...(accountId ? { accountId } : {}) },
  );
}

export async function hostChannelsDisconnect(
  channelType: ChannelType,
  accountId?: string,
): Promise<{ success: boolean }> {
  return await channelIntegrationCapabilityExecute<{ success: boolean }>(
    'channels.disconnect',
    { channelType, accountId },
    { kind: 'channel', channelType, ...(accountId ? { accountId } : {}) },
  );
}

export async function hostChannelsRequestQrCode(
  channelType: ChannelType,
): Promise<{ success: boolean; qrCode?: string; sessionId?: string }> {
  return await channelIntegrationCapabilityExecute<{ success: boolean; qrCode?: string; sessionId?: string }>(
    'channels.requestQr',
    { channelType },
    { kind: 'channel-pairing', channelType },
  );
}

export async function hostChannelsCancelSession(
  channelType: Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>,
): Promise<unknown> {
  return await channelIntegrationCapabilityExecute(
    'channels.cancelSession',
    { channelType },
    { kind: 'channel-pairing', channelType },
  );
}

export async function hostChannelsListPairingRequests(
  channelType: ChannelType,
  accountId?: string,
): Promise<{ success: boolean; requests?: ChannelPairingRequest[] }> {
  const suffix = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
  return await hostApiFetch<{ success: boolean; requests?: ChannelPairingRequest[] }>(
    `/api/channels/pairing/${encodeURIComponent(channelType)}${suffix}`,
  );
}

export async function hostChannelsApprovePairingRequest(
  channelType: ChannelType,
  input: { code: string; accountId?: string },
): Promise<{ success: boolean; approved?: { id: string; entry?: ChannelPairingRequest } }> {
  return await channelIntegrationCapabilityExecute<{ success: boolean; approved?: { id: string; entry?: ChannelPairingRequest } }>(
    'channels.approvePairing',
    { ...input, channelType },
    { kind: 'channel-pairing', channelType, ...(input.accountId ? { accountId: input.accountId } : {}), pairingId: input.code },
  );
}
