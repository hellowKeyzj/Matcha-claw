import { hostApiFetch, waitForRuntimeJobResult, type RuntimeJobSubmission } from '@/lib/host-api';
import type { ChannelType } from '@/types/channel';

async function submitChannelJob<TResult = unknown>(
  path: string,
  init: RequestInit,
): Promise<TResult> {
  const submission = await hostApiFetch<RuntimeJobSubmission<TResult>>(path, init);
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export async function hostChannelsFetchConfiguredTypes(): Promise<{ success: boolean; channels?: string[] }> {
  return await hostApiFetch<{ success: boolean; channels?: string[] }>('/api/channels/configured');
}

export interface ChannelSnapshotFetchResult {
  success: boolean;
  snapshot?: unknown;
  ready?: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
  error?: string | null;
}

export async function hostChannelsFetchSnapshot(): Promise<ChannelSnapshotFetchResult> {
  return await hostApiFetch<ChannelSnapshotFetchResult>('/api/channels/snapshot');
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
  if (input.channelType === 'whatsapp' || input.channelType === 'openclaw-weixin') {
    return await hostApiFetch<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean }>(
      '/api/channels/activate',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  }
  return await submitChannelJob<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean }>(
    '/api/channels/activate',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
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
  return await submitChannelJob(`/api/channels/config/${encodeURIComponent(channelType)}`, {
    method: 'DELETE',
  });
}

export async function hostChannelsConnect(channelId: string): Promise<{ success: boolean }> {
  return await hostApiFetch<{ success: boolean }>('/api/channels/connect', {
    method: 'POST',
    body: JSON.stringify({ channelId }),
  });
}

export async function hostChannelsDisconnect(channelId: string): Promise<{ success: boolean }> {
  return await hostApiFetch<{ success: boolean }>('/api/channels/disconnect', {
    method: 'POST',
    body: JSON.stringify({ channelId }),
  });
}

export async function hostChannelsRequestQrCode(
  channelType: ChannelType,
): Promise<{ success: boolean; qrCode?: string; sessionId?: string }> {
  return await hostApiFetch<{ success: boolean; qrCode?: string; sessionId?: string }>('/api/channels/request-qr', {
    method: 'POST',
    body: JSON.stringify({ channelType }),
  });
}

export async function hostChannelsCancelSession(
  channelType: Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>,
): Promise<unknown> {
  return await hostApiFetch('/api/channels/session/cancel', {
    method: 'POST',
    body: JSON.stringify({ channelType }),
  });
}
