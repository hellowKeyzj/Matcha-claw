import { hostApiFetch } from '@/lib/host-api';
import type { ChannelType } from '@/types/channel';

export async function hostChannelsFetchConfiguredTypes(): Promise<{ success: boolean; channels?: string[] }> {
  return await hostApiFetch<{ success: boolean; channels?: string[] }>('/api/channels/configured');
}

export async function hostChannelsFetchSnapshot(): Promise<{ success: boolean; snapshot?: unknown }> {
  return await hostApiFetch<{ success: boolean; snapshot?: unknown }>('/api/channels/snapshot');
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

export async function hostChannelsSaveConfig(input: {
  channelType: ChannelType;
  config: Record<string, unknown>;
  accountId?: string;
}): Promise<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean }> {
  return await hostApiFetch<{ success?: boolean; error?: string; warning?: string; pluginInstalled?: boolean }>(
    '/api/channels/config',
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
  return await hostApiFetch(`/api/channels/config/${encodeURIComponent(channelType)}`, {
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

export async function hostChannelsStartSession(
  channelType: Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>,
  input: { accountId?: string; config?: Record<string, unknown> },
): Promise<unknown> {
  const route = channelType === 'whatsapp'
    ? '/api/channels/whatsapp/start'
    : '/api/channels/openclaw-weixin/start';
  return await hostApiFetch(route, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function hostChannelsCancelSession(
  channelType: Extract<ChannelType, 'whatsapp' | 'openclaw-weixin'>,
): Promise<unknown> {
  const route = channelType === 'whatsapp'
    ? '/api/channels/whatsapp/cancel'
    : '/api/channels/openclaw-weixin/cancel';
  return await hostApiFetch(route, { method: 'POST' });
}
