import {
  EXTERNAL_CHANNEL_PLUGIN_BINDINGS,
  isBuiltinChannelId,
} from '../channels/channel-plugin-bindings';
import type { RuntimeClockPort } from '../common/runtime-ports';

export type CronDeliveryMode = 'none' | 'announce';
export type GatewayCronDelivery = {
  mode: CronDeliveryMode;
  channel?: string;
  to?: string;
  accountId?: string;
};

const WECHAT_CHANNEL_ALIAS = new Set(['wechat', 'openclaw-weixin']);

export function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDeliveryChannel(channel: unknown): string | undefined {
  if (typeof channel !== 'string') {
    return undefined;
  }
  const normalized = channel.trim();
  if (!normalized) {
    return undefined;
  }
  return WECHAT_CHANNEL_ALIAS.has(normalized) ? 'openclaw-weixin' : normalized;
}

function isWeChatDeliveryChannel(channel?: string): boolean {
  if (!channel) {
    return false;
  }
  return WECHAT_CHANNEL_ALIAS.has(channel.trim());
}

export function getCronDeliveryValidationError(delivery: GatewayCronDelivery): string | undefined {
  if (delivery.mode !== 'announce' || !delivery.channel) {
    return undefined;
  }
  if (!isWeChatDeliveryChannel(delivery.channel)) {
    return undefined;
  }
  if (!delivery.to) {
    return 'WeChat scheduled delivery requires delivery.to (recipient target).';
  }
  if (!delivery.accountId) {
    return 'WeChat scheduled delivery requires delivery.accountId (sending account).';
  }
  return undefined;
}

export function mergeCronDelivery(base: GatewayCronDelivery, patch: Record<string, unknown>): GatewayCronDelivery {
  const mode = typeof patch.mode === 'string'
    ? (patch.mode.trim() === 'announce' ? 'announce' : 'none')
    : base.mode;
  const channel = 'channel' in patch
    ? normalizeDeliveryChannel(patch.channel)
    : normalizeDeliveryChannel(base.channel);
  if (mode !== 'announce' || !channel) {
    return { mode: 'none' };
  }
  const to = 'to' in patch
    ? (typeof patch.to === 'string' ? patch.to.trim() : '')
    : (typeof base.to === 'string' ? base.to.trim() : '');
  const accountId = 'accountId' in patch
    ? (typeof patch.accountId === 'string' ? patch.accountId.trim() : '')
    : (typeof base.accountId === 'string' ? base.accountId.trim() : '');
  return {
    mode: 'announce',
    channel,
    ...(to ? { to } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

export function normalizeCronDelivery(rawDelivery: unknown): GatewayCronDelivery {
  if (!isRecord(rawDelivery)) {
    return { mode: 'none' };
  }
  const mode = typeof rawDelivery.mode === 'string' && rawDelivery.mode.trim() === 'announce'
    ? 'announce'
    : 'none';
  const channel = normalizeDeliveryChannel(rawDelivery.channel);
  if (mode !== 'announce' || !channel) {
    return { mode: 'none' };
  }
  const to = typeof rawDelivery.to === 'string' ? rawDelivery.to.trim() : '';
  const accountId = typeof rawDelivery.accountId === 'string' ? rawDelivery.accountId.trim() : '';
  return {
    mode,
    channel,
    ...(to ? { to } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

export function normalizeCronDeliveryPatch(rawPatch: unknown): Record<string, unknown> | undefined {
  if (!isRecord(rawPatch)) {
    return undefined;
  }
  const patch: Record<string, unknown> = {};
  if ('mode' in rawPatch) {
    patch.mode = (typeof rawPatch.mode === 'string' && rawPatch.mode.trim() === 'announce')
      ? 'announce'
      : 'none';
  }
  if ('channel' in rawPatch) {
    patch.channel = normalizeDeliveryChannel(rawPatch.channel);
  }
  if ('to' in rawPatch) {
    patch.to = typeof rawPatch.to === 'string' ? rawPatch.to.trim() : '';
  }
  if ('accountId' in rawPatch) {
    patch.accountId = typeof rawPatch.accountId === 'string' ? rawPatch.accountId.trim() : '';
  }
  return patch;
}

export function normalizeCronAgentId(value: unknown): string {
  if (typeof value !== 'string') {
    return 'main';
  }
  const normalized = value.trim();
  return normalized || 'main';
}

export function asCronCreateInput(value: unknown) {
  if (!isRecord(value)) return null;
  if (typeof value.name !== 'string' || typeof value.message !== 'string' || typeof value.schedule !== 'string') {
    return null;
  }
  return {
    name: value.name,
    agentId: normalizeCronAgentId(value.agentId),
    message: value.message,
    schedule: value.schedule,
    delivery: normalizeCronDelivery(value.delivery),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
  };
}

export function normalizeCronJob(job: Record<string, any>, clock: Pick<RuntimeClockPort, 'toIsoString'>) {
  const payload = isRecord(job.payload) ? job.payload : {};
  const delivery = normalizeCronDelivery(job.delivery);
  const state = isRecord(job.state) ? job.state : {};
  const schedule = isRecord(job.schedule) ? job.schedule : {};
  const agentId = normalizeCronAgentId(job.agentId);
  const message = payload.message || payload.text || '';
  const channelType = delivery.channel;
  const target = channelType
    ? {
      channelType,
      channelId: delivery.accountId || channelType,
      channelName: channelType,
      ...(delivery.to ? { recipient: delivery.to } : {}),
    }
    : undefined;
  const lastRun = state.lastRunAtMs
    ? {
      time: clock.toIsoString(state.lastRunAtMs),
      success: state.lastStatus === 'ok',
      error: state.lastError,
      duration: state.lastDurationMs,
    }
    : undefined;
  const nextRun = state.nextRunAtMs ? clock.toIsoString(state.nextRunAtMs) : undefined;
  const runningAt = state.runningAtMs ? clock.toIsoString(state.runningAtMs) : undefined;
  return {
    id: job.id,
    name: job.name,
    agentId,
    message,
    schedule,
    delivery,
    target,
    enabled: job.enabled,
    createdAt: clock.toIsoString(job.createdAtMs),
    updatedAt: clock.toIsoString(job.updatedAtMs),
    lastRun,
    nextRun,
    runningAt,
  };
}

export function parseGatewayCronJobs(value: unknown) {
  const record = isRecord(value) ? value : {};
  const jobs = Array.isArray(record.jobs) ? record.jobs : [];
  return jobs.filter((entry) => isRecord(entry) && typeof entry.id === 'string') as Array<Record<string, any>>;
}

function channelSectionHasEnabledAccount(sectionRaw: unknown): boolean {
  if (!isRecord(sectionRaw) || sectionRaw.enabled === false) {
    return false;
  }
  const accounts = isRecord(sectionRaw.accounts) ? sectionRaw.accounts : null;
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((item) => !isRecord(item) || item.enabled !== false);
}

export function listConfiguredBuiltinChannelIdsFromConfig(config: Record<string, unknown>): string[] {
  const channels = isRecord(config.channels) ? config.channels : {};
  const configured: string[] = [];

  for (const [channelType, sectionRaw] of Object.entries(channels)) {
    if (!isBuiltinChannelId(channelType)) {
      continue;
    }
    if (channelSectionHasEnabledAccount(sectionRaw)) {
      configured.push(channelType);
    }
  }

  return configured.sort((left, right) => left.localeCompare(right, 'en'));
}

export function listConfiguredExternalChannelPluginIdsFromConfig(config: Record<string, unknown>): string[] {
  const channels = isRecord(config.channels) ? config.channels : {};
  const configured: string[] = [];

  for (const binding of EXTERNAL_CHANNEL_PLUGIN_BINDINGS) {
    if (channelSectionHasEnabledAccount(channels[binding.channelType])) {
      configured.push(binding.pluginId);
    }
  }

  return configured.sort((left, right) => left.localeCompare(right, 'en'));
}
