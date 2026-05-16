type TelemetryPayload = Record<string, unknown>;
export type UiTelemetryEntry = {
  id: number;
  event: string;
  payload: TelemetryPayload;
  count: number;
  ts: string;
};

interface SamplingRule {
  readonly keyFields: readonly string[];
  readonly windowMs: number;
}

// 高频 telemetry 事件按 (event + keyFields) 维度做时间窗口 sampling，避免 history / listeners /
// console 在长跑场景被同 path 的成百上千次刷新挤爆。命中 cooldown 的事件仍在 counters 累加，
// 用户看总量不变，只是不再每次都写 history / 通知 listeners / 打 console。
const SAMPLING_RULES: Record<string, SamplingRule> = {
  'hostapi.fetch': { keyFields: ['path', 'method', 'source'], windowMs: 1_000 },
  'hostapi.fetch_error': { keyFields: ['path', 'method', 'source'], windowMs: 1_000 },
};

const counters = new Map<string, number>();
const samplingLastEmittedAt = new Map<string, number>();
const history: UiTelemetryEntry[] = [];
const listeners = new Set<(entry: UiTelemetryEntry) => void>();
let nextEntryId = 1;
const MAX_HISTORY = 500;

function safeStringify(payload: TelemetryPayload): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return '{}';
  }
}

function readSamplingFieldValue(payload: TelemetryPayload, field: string): string {
  const value = payload[field];
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function buildSamplingKey(event: string, payload: TelemetryPayload, rule: SamplingRule): string {
  const parts: string[] = [event];
  for (const field of rule.keyFields) {
    parts.push(readSamplingFieldValue(payload, field));
  }
  return parts.join('|');
}

function shouldSample(event: string, payload: TelemetryPayload, nowMs: number): boolean {
  const rule = SAMPLING_RULES[event];
  if (!rule) {
    return false;
  }
  const samplingKey = buildSamplingKey(event, payload, rule);
  const lastEmittedAt = samplingLastEmittedAt.get(samplingKey) ?? 0;
  if (nowMs - lastEmittedAt < rule.windowMs) {
    return true;
  }
  samplingLastEmittedAt.set(samplingKey, nowMs);
  return false;
}

export function trackUiEvent(event: string, payload: TelemetryPayload = {}): void {
  const count = (counters.get(event) ?? 0) + 1;
  counters.set(event, count);

  if (shouldSample(event, payload, Date.now())) {
    return;
  }

  const normalizedPayload = {
    ...payload,
  };
  const ts = new Date().toISOString();
  const entry: UiTelemetryEntry = {
    id: nextEntryId,
    event,
    payload: normalizedPayload,
    count,
    ts,
  };
  nextEntryId += 1;

  history.push(entry);
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  listeners.forEach((listener) => listener(entry));

  const logPayload = {
    ...normalizedPayload,
    count,
    ts,
  };

  // Local-only telemetry for UX diagnostics.
  console.info(`[ui-metric] ${event} ${safeStringify(logPayload)}`);
}

export function getUiCounter(event: string): number {
  return counters.get(event) ?? 0;
}

export function trackUiTiming(
  event: string,
  durationMs: number,
  payload: TelemetryPayload = {},
): void {
  trackUiEvent(event, {
    ...payload,
    durationMs: Math.round(durationMs),
  });
}

export function startUiTiming(
  event: string,
  payload: TelemetryPayload = {},
): (nextPayload?: TelemetryPayload) => number {
  const start = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

  return (nextPayload: TelemetryPayload = {}): number => {
    const end = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    const durationMs = Math.max(0, end - start);
    trackUiTiming(event, durationMs, { ...payload, ...nextPayload });
    return durationMs;
  };
}

export function getUiTelemetrySnapshot(limit = 200): UiTelemetryEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) {
    return [];
  }
  if (limit >= history.length) {
    return [...history];
  }
  return history.slice(-limit);
}

export function clearUiTelemetry(): void {
  counters.clear();
  samplingLastEmittedAt.clear();
  history.length = 0;
}

export function subscribeUiTelemetry(listener: (entry: UiTelemetryEntry) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
