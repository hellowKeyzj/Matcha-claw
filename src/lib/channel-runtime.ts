import { hostApiFetch, hostCapabilityExecute, waitForRuntimeJobResult, type RuntimeJobSubmission } from '@/lib/host-api';
import type { ChannelType } from '@/types/channel';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';

const CHANNEL_INTEGRATION_CAPABILITY_ID = 'integration.channel';

async function channelIntegrationCapabilityExecute<TResult>(
  operationId: string,
  runtimeAddress: RuntimeAddress,
  input: Record<string, unknown> = {},
): Promise<TResult> {
  return await hostCapabilityExecute<TResult>({
    id: CHANNEL_INTEGRATION_CAPABILITY_ID,
    operationId,
    runtimeAddress,
    input: {
      ...input,
      runtimeAddress,
    },
  });
}

async function submitChannelCapabilityJob<TResult = unknown>(
  operationId: string,
  runtimeAddress: RuntimeAddress,
  input: Record<string, unknown> = {},
): Promise<TResult> {
  const submission = await channelIntegrationCapabilityExecute<RuntimeJobSubmission<TResult>>(operationId, runtimeAddress, input);
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

export async function hostChannelsProbe(runtimeAddress: RuntimeAddress): Promise<unknown> {
  return await submitChannelCapabilityJob('channels.probe', runtimeAddress);
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
}, runtimeAddress: RuntimeAddress): Promise<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean }> {
  if (input.channelType === 'whatsapp' || input.channelType === 'openclaw-weixin') {
    return await channelIntegrationCapabilityExecute<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean }>(
      'channels.activate',
      runtimeAddress,
      input,
    );
  }
  return await submitChannelCapabilityJob<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean }>(
    'channels.activate',
    runtimeAddress,
    input,
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

export async function hostChannelsDeleteConfig(channelType: ChannelType, runtimeAddress: RuntimeAddress): Promise<unknown> {
  return await submitChannelCapabilityJob('channels.deleteConfig', runtimeAddress, { channelType });
}

export async function hostChannelsConnect(
  channelType: ChannelType,
  accountId: string | undefined,
  runtimeAddress: RuntimeAddress,
): Promise<{ success: boolean }> {
  return await channelIntegrationCapabilityExecute<{ success: boolean }>('channels.connect', runtimeAddress, { channelType, accountId });
}

export async function hostChannelsDisconnect(
  channelType: ChannelType,
  accountId: string | undefined,
  runtimeAddress: RuntimeAddress,
): Promise<{ success: boolean }> {
  return await channelIntegrationCapabilityExecute<{ success: boolean }>('channels.disconnect', runtimeAddress, { channelType, accountId });
}

export async function hostChannelsRequestQrCode(
  channelType: ChannelType,
  runtimeAddress: RuntimeAddress,
): Promise<{ success: boolean; qrCode?: string; sessionId?: string }> {
  return await channelIntegrationCapabilityExecute<{ success: boolean; qrCode?: string; sessionId?: string }>(
    'channels.requestQr',
    runtimeAddress,
    { channelType },
  );
}

export async function hostChannelsCancelSession(
  channelType: Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>,
  runtimeAddress: RuntimeAddress,
): Promise<unknown> {
  return await channelIntegrationCapabilityExecute('channels.cancelSession', runtimeAddress, { channelType });
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
  runtimeAddress: RuntimeAddress,
): Promise<{ success: boolean; approved?: { id: string; entry?: ChannelPairingRequest } }> {
  return await channelIntegrationCapabilityExecute<{ success: boolean; approved?: { id: string; entry?: ChannelPairingRequest } }>(
    'channels.approvePairing',
    runtimeAddress,
    { ...input, channelType },
  );
}
