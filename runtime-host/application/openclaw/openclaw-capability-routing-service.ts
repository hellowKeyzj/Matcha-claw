/**
 * OpenClaw 能力路由写盘服务。
 *
 * 唯一职责：把 CapabilityRouting 写到 openclaw.json 的下面这几处：
 *   - agents.defaults.model              ← chat
 *   - agents.defaults.imageModel         ← imageUnderstand
 *   - agents.defaults.imageGenerationModel
 *   - agents.defaults.videoGenerationModel
 *   - agents.defaults.musicGenerationModel
 *   - messages.tts.provider              ← tts
 *
 * 关键约束：
 *   - 写入是"按字段独立 upsert"。某能力被设为空时，移除对应字段而不是写空对象。
 *   - 对应能力为空且字段当前不存在，等价于无操作；不会引入 noise diff。
 *   - 不读取/不写入除上述路径之外的任何 OpenClaw 配置；与凭证、模型清单完全解耦。
 */

import type { OpenClawConfigRepositoryPort } from './openclaw-config-repository';
import { withOpenClawConfigLock } from './openclaw-config-mutex';

export interface ModelRouteRef {
  readonly providerKey: string;
  readonly modelId: string;
}

export interface ModelRouteValue {
  readonly primary: ModelRouteRef;
  readonly fallbacks: readonly ModelRouteRef[];
}

export interface CapabilityRoutingValue {
  readonly chat?: ModelRouteValue;
  readonly imageUnderstand?: ModelRouteValue;
  readonly imageGenerate?: ModelRouteValue;
  readonly videoGenerate?: ModelRouteValue;
  readonly musicGenerate?: ModelRouteValue;
  readonly tts?: { readonly providerKey: string };
}

export type CapabilityRoutingFieldKey =
  | 'chat'
  | 'imageUnderstand'
  | 'imageGenerate'
  | 'videoGenerate'
  | 'musicGenerate'
  | 'tts';

const ROUTE_CAPABILITIES: readonly Exclude<CapabilityRoutingFieldKey, 'tts'>[] = [
  'chat',
  'imageUnderstand',
  'imageGenerate',
  'videoGenerate',
  'musicGenerate',
];

const MEDIA_ROUTE_CAPABILITIES = new Set<CapabilityRoutingFieldKey>([
  'imageGenerate',
  'videoGenerate',
  'musicGenerate',
]);

const AGENTS_DEFAULTS_KEY: Record<Exclude<CapabilityRoutingFieldKey, 'tts'>, string> = {
  chat: 'model',
  imageUnderstand: 'imageModel',
  imageGenerate: 'imageGenerationModel',
  videoGenerate: 'videoGenerationModel',
  musicGenerate: 'musicGenerationModel',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function refToString(ref: ModelRouteRef): string {
  return `${ref.providerKey}/${ref.modelId}`;
}

function parseModelRefString(raw: unknown): ModelRouteRef | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const providerKey = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (!providerKey || !modelId) return null;
  return { providerKey, modelId };
}

function ensureAgentsDefaults(config: Record<string, unknown>): Record<string, unknown> {
  const agents = isRecord(config.agents) ? { ...config.agents } : {};
  const defaults = isRecord(agents.defaults) ? { ...agents.defaults } : {};
  agents.defaults = defaults;
  config.agents = agents;
  return defaults;
}

function ensureMessagesTts(config: Record<string, unknown>): Record<string, unknown> {
  const messages = isRecord(config.messages) ? { ...config.messages } : {};
  const tts = isRecord(messages.tts) ? { ...messages.tts } : {};
  messages.tts = tts;
  config.messages = messages;
  return tts;
}

function applyRouteToAgentsDefaults(
  defaults: Record<string, unknown>,
  agentsKey: string,
  route: ModelRouteValue | undefined,
): void {
  if (!route) {
    delete defaults[agentsKey];
    return;
  }
  const value: Record<string, unknown> = {
    primary: refToString(route.primary),
    fallbacks: route.fallbacks.map((ref) => refToString(ref)),
  };
  defaults[agentsKey] = value;
}

function applyTtsProvider(config: Record<string, unknown>, providerKey: string | undefined): void {
  if (!providerKey) {
    const messages = isRecord(config.messages) ? config.messages : null;
    if (!messages || !isRecord(messages.tts)) return;
    const nextTts = { ...messages.tts };
    delete nextTts.provider;
    if (Object.keys(nextTts).length === 0) {
      const nextMessages = { ...messages };
      delete nextMessages.tts;
      config.messages = nextMessages;
    } else {
      config.messages = { ...messages, tts: nextTts };
    }
    return;
  }
  const tts = ensureMessagesTts(config);
  tts.provider = providerKey;
}

function readRouteFromAgentsDefaults(
  defaults: Record<string, unknown>,
  agentsKey: string,
): ModelRouteValue | undefined {
  const rawRoute = defaults[agentsKey];
  if (!isRecord(rawRoute)) return undefined;
  const primary = parseModelRefString(rawRoute.primary);
  if (!primary) return undefined;
  const fallbacks = Array.isArray(rawRoute.fallbacks)
    ? rawRoute.fallbacks
      .map((fallback) => parseModelRefString(fallback))
      .filter((fallback): fallback is ModelRouteRef => fallback !== null)
    : [];
  return {
    primary,
    fallbacks,
  };
}

function readTtsProvider(config: Record<string, unknown>): { readonly providerKey: string } | undefined {
  const messages = isRecord(config.messages) ? config.messages : {};
  const tts = isRecord(messages.tts) ? messages.tts : {};
  const providerKey = typeof tts.provider === 'string' ? tts.provider.trim() : '';
  return providerKey ? { providerKey } : undefined;
}

export class OpenClawCapabilityRoutingService {
  constructor(private readonly configRepository: OpenClawConfigRepositoryPort) {}

  async read(): Promise<CapabilityRoutingValue> {
    const config = await this.configRepository.read();
    const agents = isRecord(config.agents) ? config.agents : {};
    const defaults = isRecord(agents.defaults) ? agents.defaults : {};
    const routing: CapabilityRoutingValue = {};
    for (const capability of ROUTE_CAPABILITIES) {
      const route = readRouteFromAgentsDefaults(defaults, AGENTS_DEFAULTS_KEY[capability]);
      if (route) {
        routing[capability] = route;
      }
    }
    const tts = readTtsProvider(config);
    if (tts) {
      routing.tts = tts;
    }
    return routing;
  }

  async replace(routing: CapabilityRoutingValue): Promise<void> {
    return await withOpenClawConfigLock(async () => {
      const config = await this.configRepository.read();
      const defaults = ensureAgentsDefaults(config);
      for (const capability of ROUTE_CAPABILITIES) {
        applyRouteToAgentsDefaults(defaults, AGENTS_DEFAULTS_KEY[capability], routing[capability]);
      }
      if (hasAnyMediaRoute(routing)) {
        defaults.mediaGenerationAutoProviderFallback = false;
      } else {
        delete defaults.mediaGenerationAutoProviderFallback;
      }
      applyTtsProvider(config, routing.tts?.providerKey);
      await this.configRepository.write(config);
    });
  }
}

function hasAnyMediaRoute(routing: CapabilityRoutingValue): boolean {
  for (const capability of MEDIA_ROUTE_CAPABILITIES) {
    if (routing[capability]?.primary) return true;
  }
  return false;
}
