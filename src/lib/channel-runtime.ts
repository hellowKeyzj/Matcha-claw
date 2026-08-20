import { hostApiFetch } from '@/lib/host-api';
import type { ChannelType } from '@/types/channel';

export interface ChannelSnapshotFetchResult {
  success: boolean;
  snapshot?: unknown;
  ready?: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
  error?: string | null;
}

export interface ChannelLoginProgress {
  outcome: 'progress' | 'connected' | 'target_rejected' | 'unknown';
  channel: string;
  accountId?: string;
  qrDataUrl?: string;
  sessionKey?: string;
}

export interface ChannelLoginWaitOptions {
  timeoutMs?: number;
  sessionKey?: string;
  currentQrDataUrl?: string;
  signal?: AbortSignal;
}

export interface ChannelPairingRequest {
  id: string;
  status: 'pending' | 'unknown';
}

export async function hostChannelsFetchSnapshot(): Promise<ChannelSnapshotFetchResult> {
  return await hostApiFetch<ChannelSnapshotFetchResult>('/api/channels/snapshot');
}

export async function hostChannelsProbe(): Promise<never> {
  throw new Error('Channel probe is unavailable');
}

export async function hostChannelsReadConfig(
  channelType: ChannelType,
  accountId?: string,
): Promise<{ success: boolean; values?: Record<string, string> }> {
  return await hostApiFetch<{ success: boolean; values?: Record<string, string> }>(
    '/api/channels/config/read',
    {
      method: 'POST',
      body: JSON.stringify({
        channel: channelType,
        ...(accountId ? { accountId } : {}),
      }),
    },
  );
}

export async function hostChannelsActivate(input: {
  channelType: ChannelType;
  config: Record<string, unknown>;
  accountId?: string;
}): Promise<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean; progress?: ChannelLoginProgress }> {
  if (input.channelType === 'whatsapp' || input.channelType === 'openclaw-weixin') {
    const result = await hostApiFetch<ChannelLoginProgress>('/api/channels/login', {
      method: 'POST',
      body: JSON.stringify({
        action: 'start',
        channel: input.channelType,
        accountId: input.accountId ?? 'default',
        force: true,
        config: input.config,
      }),
    });
    if (result.outcome === 'progress' || result.outcome === 'connected') {
      return { success: true, progress: result };
    }
    return {
      success: false,
      error: result.outcome === 'target_rejected'
        ? 'Channel activation was rejected'
        : 'Channel activation outcome is unknown',
    };
  }
  const result = await hostApiFetch<{ outcome: 'confirmed' | 'target_rejected' | 'unknown' }>('/api/channels/configure', {
    method: 'POST',
    body: JSON.stringify({
      action: 'apply',
      channel: input.channelType,
      accountId: input.accountId ?? 'default',
      values: input.config,
    }),
  });
  if (result.outcome === 'confirmed') {
    return { success: true };
  }
  return {
    success: false,
    error: result.outcome === 'target_rejected'
      ? 'Channel configuration was rejected'
      : 'Channel configuration outcome is unknown',
  };
}

export async function hostChannelsLoginWait(
  channelType: Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>,
  accountId: string,
  options: ChannelLoginWaitOptions = {},
): Promise<ChannelLoginProgress> {
  return await hostApiFetch<ChannelLoginProgress>('/api/channels/login', {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    body: JSON.stringify({
      action: 'wait',
      channel: channelType,
      accountId,
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
      ...(options.currentQrDataUrl ? { currentQrDataUrl: options.currentQrDataUrl } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    }),
  });
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

export async function hostChannelsDeleteConfig(
  channelType: ChannelType,
  accountId = 'default',
): Promise<{ outcome: 'confirmed' | 'target_rejected' | 'unknown' }> {
  return await hostApiFetch<{ outcome: 'confirmed' | 'target_rejected' | 'unknown' }>('/api/channels/delete-config', {
    method: 'POST',
    body: JSON.stringify({ channel: channelType, accountId }),
  });
}

export async function hostChannelsConnect(
  channelType: ChannelType,
  accountId?: string,
): Promise<{ success: boolean }> {
  const result = await hostApiFetch<{ outcome: 'confirmed' | 'target_rejected' | 'unknown' }>('/api/channels/control', {
    method: 'POST',
    body: JSON.stringify({
      action: 'connect',
      channel: channelType,
      accountId: accountId ?? 'default',
    }),
  });
  return { success: result.outcome === 'confirmed' };
}

export async function hostChannelsDisconnect(
  channelType: ChannelType,
  accountId?: string,
): Promise<{ success: boolean }> {
  const result = await hostApiFetch<{ outcome: 'confirmed' | 'target_rejected' | 'unknown' }>('/api/channels/control', {
    method: 'POST',
    body: JSON.stringify({
      action: 'disconnect',
      channel: channelType,
      accountId: accountId ?? 'default',
    }),
  });
  return { success: result.outcome === 'confirmed' };
}

export async function hostChannelsCancelSession(
  channelType: Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>,
  accountId: string,
): Promise<{ outcome: 'cancelled' }> {
  return await hostApiFetch<{ outcome: 'cancelled' }>('/api/channels/login', {
    method: 'POST',
    body: JSON.stringify({
      action: 'cancel',
      channel: channelType,
      ...(accountId ? { accountId } : {}),
    }),
  });
}

export async function hostChannelsListPairingRequests(
  channelType: ChannelType,
  accountId?: string,
): Promise<{ success: boolean; requests?: ChannelPairingRequest[] }> {
  void accountId;
  const result = await hostApiFetch<{ requests: readonly ChannelPairingRequest[] }>('/api/channels/pairing', {
    method: 'POST',
    body: JSON.stringify({ channel: channelType }),
  });
  return { success: true, requests: [...result.requests] };
}

export async function hostChannelsApprovePairingRequest(
  channelType: ChannelType,
  input: { code: string; accountId?: string },
): Promise<{ success: boolean }> {
  const result = await hostApiFetch<{ outcome: 'confirmed' | 'target_rejected' | 'unknown' }>('/api/channels/pairing', {
    method: 'POST',
    body: JSON.stringify({
      action: 'approve',
      channel: channelType,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      code: input.code,
    }),
  });
  if (result.outcome === 'confirmed') {
    return { success: true };
  }
  throw new Error(result.outcome === 'target_rejected'
    ? 'Channel pairing approval was rejected'
    : 'Channel pairing approval outcome is unknown');
}
