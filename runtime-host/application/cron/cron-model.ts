import type { RuntimeClockPort } from '../common/runtime-ports';

export type CronDeliveryMode = 'none' | 'announce';
export type GatewayCronDelivery = {
  mode: CronDeliveryMode;
  channel?: string;
  to?: string;
  accountId?: string;
};

export interface CronDeliveryChannelProjectionPort {
  normalizeDeliveryChannel(channel: string): string;
  requiresDeliveryTarget(channel: string): boolean;
  getDeliveryTargetLabel(channel: string): string;
}

export const DEFAULT_CRON_DELIVERY_CHANNEL_PROJECTION: CronDeliveryChannelProjectionPort = {
  normalizeDeliveryChannel: (channel) => channel,
  requiresDeliveryTarget: () => false,
  getDeliveryTargetLabel: () => 'Channel',
};

export function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDeliveryChannel(
  channel: unknown,
  projection: CronDeliveryChannelProjectionPort = DEFAULT_CRON_DELIVERY_CHANNEL_PROJECTION,
): string | undefined {
  if (typeof channel !== 'string') {
    return undefined;
  }
  const normalized = projection.normalizeDeliveryChannel(channel.trim());
  return normalized || undefined;
}

export function getCronDeliveryValidationError(
  delivery: GatewayCronDelivery,
  projection: CronDeliveryChannelProjectionPort = DEFAULT_CRON_DELIVERY_CHANNEL_PROJECTION,
): string | undefined {
  if (delivery.mode !== 'announce' || !delivery.channel || !projection.requiresDeliveryTarget(delivery.channel)) {
    return undefined;
  }
  const label = projection.getDeliveryTargetLabel(delivery.channel);
  if (!delivery.to) {
    return `${label} scheduled delivery requires delivery.to (recipient target).`;
  }
  if (!delivery.accountId) {
    return `${label} scheduled delivery requires delivery.accountId (sending account).`;
  }
  return undefined;
}

export function mergeCronDelivery(
  base: GatewayCronDelivery,
  patch: Record<string, unknown>,
  projection: CronDeliveryChannelProjectionPort = DEFAULT_CRON_DELIVERY_CHANNEL_PROJECTION,
): GatewayCronDelivery {
  const mode = typeof patch.mode === 'string'
    ? (patch.mode.trim() === 'announce' ? 'announce' : 'none')
    : base.mode;
  const channel = 'channel' in patch
    ? normalizeDeliveryChannel(patch.channel, projection)
    : normalizeDeliveryChannel(base.channel, projection);
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

export function normalizeCronDelivery(
  rawDelivery: unknown,
  projection: CronDeliveryChannelProjectionPort = DEFAULT_CRON_DELIVERY_CHANNEL_PROJECTION,
): GatewayCronDelivery {
  if (!isRecord(rawDelivery)) {
    return { mode: 'none' };
  }
  const mode = typeof rawDelivery.mode === 'string' && rawDelivery.mode.trim() === 'announce'
    ? 'announce'
    : 'none';
  const channel = normalizeDeliveryChannel(rawDelivery.channel, projection);
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

export function normalizeCronDeliveryPatch(
  rawPatch: unknown,
  projection: CronDeliveryChannelProjectionPort = DEFAULT_CRON_DELIVERY_CHANNEL_PROJECTION,
): Record<string, unknown> | undefined {
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
    patch.channel = normalizeDeliveryChannel(rawPatch.channel, projection);
  }
  if ('to' in rawPatch) {
    patch.to = typeof rawPatch.to === 'string' ? rawPatch.to.trim() : '';
  }
  if ('accountId' in rawPatch) {
    patch.accountId = typeof rawPatch.accountId === 'string' ? rawPatch.accountId.trim() : '';
  }
  return patch;
}

export function normalizeCronAgentId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

export function asCronCreateInput(
  value: unknown,
  projection: CronDeliveryChannelProjectionPort = DEFAULT_CRON_DELIVERY_CHANNEL_PROJECTION,
) {
  if (!isRecord(value)) return null;
  if (typeof value.name !== 'string' || typeof value.message !== 'string' || typeof value.schedule !== 'string') {
    return null;
  }
  const agentId = normalizeCronAgentId(value.agentId);
  if (!agentId) {
    return null;
  }
  return {
    name: value.name,
    agentId,
    message: value.message,
    schedule: value.schedule,
    delivery: normalizeCronDelivery(value.delivery, projection),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
  };
}

export function normalizeCronJob(
  job: Record<string, any>,
  clock: Pick<RuntimeClockPort, 'toIsoString'>,
  projection: CronDeliveryChannelProjectionPort = DEFAULT_CRON_DELIVERY_CHANNEL_PROJECTION,
) {
  const payload = isRecord(job.payload) ? job.payload : {};
  const delivery = normalizeCronDelivery(job.delivery, projection);
  const state = isRecord(job.state) ? job.state : {};
  const schedule = isRecord(job.schedule) ? job.schedule : {};
  const agentId = normalizeCronAgentId(job.agentId);
  if (!agentId) {
    return null;
  }
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

