import { hostApiFetch, hostApiFetchDecoded } from '@/lib/host-api';
import { decodeCallReceipt } from '@/types/call-log/receipt';
import type { ChannelType } from '@/types/channel';
import { waitForCall } from '@/lib/call-log-await';
import { decodeChannelsCallDetail } from '@/types/call-log/channels';
import type { CallReceipt } from '@/types/call-log';

export function channelErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'AUTH_INVALID': case 'TIMEOUT': case 'ABORTED': case 'RATE_LIMIT':
    case 'PERMISSION': case 'CHANNEL_UNAVAILABLE': case 'UNAVAILABLE':
    case 'NETWORK': case 'CONFIG': case 'GATEWAY':
      return code;
    default:
      return error instanceof DOMException && error.name === 'AbortError' ? 'ABORTED' : 'UNKNOWN';
  }
}

export function logChannelTrace(
  phase: string,
  traceId: string | undefined,
  detail: { outcome?: string; durationMs?: number; accountPresent?: boolean; errorCode?: string; gatewayOperational?: boolean } = {},
): void {
  if (!traceId) return;
  console.info(`[startup-trace] ${JSON.stringify({ source: 'channel-renderer', traceId, phase, at: Date.now(), ...detail })}`);
}

export interface ChannelSnapshotFetchResult {
  success: boolean;
  snapshot?: unknown;
  ready?: boolean;
  refreshing?: boolean;
  updatedAt?: number | null;
  error?: string | null;
}

export interface ChannelLoginProgress {
  callId?: string;
  outcome: 'progress' | 'connected' | 'target_rejected' | 'unknown';
  channel: string;
  accountId?: string;
  qrDataUrl?: string;
  sessionKey?: string;
}

export interface ChannelLoginWaitOptions {
  timeoutMs?: number;
  traceId?: string;
  sessionKey?: string;
  currentQrDataUrl?: string;
  signal?: AbortSignal;
}

export interface ChannelAuthorizationProgress {
  callId?: string;
  outcome: 'progress' | 'connected' | 'target_rejected' | 'unknown' | 'cancelled';
  channel: string;
  accountId?: string;
  qrDataUrl?: string;
  authorizationUrl?: string;
  sessionKey?: string;
  expiresAt?: number;
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
  options?: { traceId?: string },
): Promise<{ success: true; values: Record<string, string>; agentId: string | null }> {
  return await hostApiFetch<{ success: true; values: Record<string, string>; agentId: string | null }>(
    '/api/channels/config/read',
    {
      traceId: options?.traceId,
      method: 'POST',
      body: JSON.stringify({
        channel: channelType,
        ...(accountId ? { accountId } : {}),
      }),
    },
  );
}

export async function hostChannelsConfigure(input: {
  channelType: ChannelType;
  config: Record<string, unknown>;
  accountId?: string;
  agentId?: string;
}, options?: { traceId?: string }): Promise<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean }> {
  const agentId = input.agentId?.trim();
  const result = await hostApiFetch<CallReceipt | { outcome: 'confirmed' | 'target_rejected' | 'unknown' }>('/api/channels/configure', {
    traceId: options?.traceId,
    timeoutMs: 240_000,
    method: 'POST',
    body: JSON.stringify({
      action: 'apply',
      channel: input.channelType,
      accountId: input.accountId ?? 'default',
      ...(agentId ? { agentId } : {}),
      values: input.config,
    }),
  });
  let outcome: 'confirmed' | 'target_rejected' | 'unknown';
  if ('callId' in result) {
    const record = await waitForCall(result, 'channels');
    const detail = decodeChannelsCallDetail(record.detail);
    if (detail.operation !== 'configure') throw new Error('Invalid channels configure call');
    outcome = detail.outcome === 'confirmed' ? 'confirmed' : detail.outcome === 'rejected' ? 'target_rejected' : 'unknown';
  } else {
    outcome = result.outcome;
  }
  if (outcome === 'confirmed') {
    return { success: true };
  }
  return {
    success: false,
    error: outcome === 'target_rejected'
      ? 'Channel configuration was rejected'
      : 'Channel configuration outcome is unknown',
  };
}

export async function hostChannelsActivate(input: {
  channelType: ChannelType;
  config: Record<string, unknown>;
  accountId?: string;
  agentId?: string;
}, options?: { traceId?: string }): Promise<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean; progress?: ChannelLoginProgress }> {
  const agentId = input.agentId?.trim();
  if (input.channelType === 'whatsapp' || input.channelType === 'openclaw-weixin') {
    const result = await hostApiFetch<ChannelLoginProgress>('/api/channels/login', {
      traceId: options?.traceId,
      method: 'POST',
      body: JSON.stringify({
        action: 'start',
        channel: input.channelType,
        accountId: input.accountId ?? 'default',
        ...(agentId ? { agentId } : {}),
        force: true,
        config: input.config,
      }),
    });
    if (result.outcome === 'progress' || result.outcome === 'connected') {
      const progress = await settleConnectedChannel(result, 'login');
      return progress.outcome === 'connected' || progress.outcome === 'progress'
        ? { success: true, progress }
        : { success: false, error: 'Channel login configuration could not be confirmed', progress };
    }
    return {
      success: false,
      error: result.outcome === 'target_rejected'
        ? 'Channel activation was rejected'
        : 'Channel activation outcome is unknown',
    };
  }
  return await hostChannelsConfigure(input, options);
}

export async function hostChannelsLoginWait(
  channelType: Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>,
  accountId: string,
  options: ChannelLoginWaitOptions = {},
): Promise<ChannelLoginProgress> {
  const progress = await hostApiFetch<ChannelLoginProgress>('/api/channels/login', {
    method: 'POST',
    traceId: options.traceId,
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
  return settleConnectedChannel(progress, 'login', options.signal);
}

async function settleConnectedChannel<T extends ChannelLoginProgress | ChannelAuthorizationProgress>(
  progress: T,
  operation: 'login' | 'configure',
  signal?: AbortSignal,
): Promise<T> {
  if (progress.outcome !== 'connected' || !progress.callId) return progress;
  const record = await waitForCall({ callId: progress.callId, accepted: true }, 'channels', { signal });
  const detail = decodeChannelsCallDetail(record.detail);
  if (operation === 'configure'
    ? detail.operation !== 'configure'
    : detail.operation !== 'loginStart' && detail.operation !== 'loginWait') {
    throw new Error(`Invalid channels ${operation} call`);
  }
  if (record.status === 'succeeded') return progress;
  return { ...progress, outcome: record.status === 'rejected' ? 'target_rejected' : 'unknown' };
}

export async function hostChannelsStartAuthorization(input: {
  channelType: Extract<ChannelType, 'qqbot' | 'dingtalk' | 'feishu'>;
  accountId?: string;
  agentId?: string;
  config?: Record<string, unknown>;
}, options?: { traceId?: string }): Promise<ChannelAuthorizationProgress> {
  const agentId = input.agentId?.trim();
  const progress = await hostApiFetch<ChannelAuthorizationProgress>('/api/channels/authorization', {
    traceId: options?.traceId,
    method: 'POST',
    body: JSON.stringify({
      action: 'start',
      channel: input.channelType,
      accountId: input.accountId ?? 'default',
      ...(agentId ? { agentId } : {}),
      ...(input.config ? { config: input.config } : {}),
    }),
  });
  return settleConnectedChannel(progress, 'configure');
}

export async function hostChannelsWaitAuthorization(
  channelType: Extract<ChannelType, 'qqbot' | 'dingtalk' | 'feishu'>,
  sessionKey: string,
  options: { traceId?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ChannelAuthorizationProgress> {
  const progress = await hostApiFetch<ChannelAuthorizationProgress>('/api/channels/authorization', {
    traceId: options.traceId,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    method: 'POST',
    body: JSON.stringify({
      action: 'wait',
      channel: channelType,
      sessionKey,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    }),
  });
  return settleConnectedChannel(progress, 'configure', options.signal);
}

export async function hostChannelsCancelAuthorization(
  channelType: Extract<ChannelType, 'qqbot' | 'dingtalk' | 'feishu'>,
  sessionKey: string,
  options?: { traceId?: string },
): Promise<ChannelAuthorizationProgress> {
  return await hostApiFetch<ChannelAuthorizationProgress>('/api/channels/authorization', {
    traceId: options?.traceId,
    method: 'POST',
    body: JSON.stringify({
      action: 'cancel',
      channel: channelType,
      sessionKey,
    }),
  });
}

export async function hostChannelsValidateCredentials(
  channelType: ChannelType,
  config: Record<string, string>,
  options?: { traceId?: string },
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
    traceId: options?.traceId,
    method: 'POST',
    body: JSON.stringify({ channelType, config }),
  });
}

export async function hostChannelsDeleteConfig(
  channelType: ChannelType,
  accountId?: string,
  options?: { traceId?: string },
): Promise<{ outcome: 'confirmed' | 'target_rejected' | 'unknown' }> {
  const receipt = await hostApiFetchDecoded('/api/channels/delete-config', decodeCallReceipt, {
    traceId: options?.traceId,
    method: 'POST',
    body: JSON.stringify({ channel: channelType, accountId }),
  });
  const record = await waitForCall(receipt, 'channels');
  const detail = decodeChannelsCallDetail(record.detail);
  if (record.command !== 'deleteConfig' || detail.operation !== 'deleteConfig'
    || detail.channel !== channelType || detail.accountId !== (accountId ?? null)) {
    throw new Error('Invalid channels delete call');
  }
  return {
    outcome: record.status === 'succeeded' && detail.outcome === 'confirmed' ? 'confirmed'
      : record.status === 'rejected' && detail.outcome === 'rejected' ? 'target_rejected' : 'unknown',
  };
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
  const receipt = await hostApiFetchDecoded('/api/channels/control', decodeCallReceipt, {
    method: 'POST',
    body: JSON.stringify({
      action: 'disconnect',
      channel: channelType,
      accountId: accountId ?? 'default',
    }),
  });
  const record = await waitForCall(receipt, 'channels');
  const detail = decodeChannelsCallDetail(record.detail);
  if (record.command !== 'disconnect' || detail.operation !== 'disconnect'
    || detail.channel !== channelType || detail.accountId !== (accountId ?? 'default')) {
    throw new Error('Invalid channels disconnect call');
  }
  return { success: record.status === 'succeeded' && detail.outcome === 'confirmed' };
}

export async function hostChannelsCancelSession(
  channelType: Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>,
  accountId: string,
  options?: { traceId?: string },
): Promise<{ outcome: 'cancelled' }> {
  return await hostApiFetch<{ outcome: 'cancelled' }>('/api/channels/login', {
    traceId: options?.traceId,
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
  const result = await hostApiFetch<{ requests: readonly ChannelPairingRequest[] }>('/api/channels/pairing', {
    method: 'POST',
    body: JSON.stringify({
      channel: channelType,
      ...(accountId ? { accountId } : {}),
    }),
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
