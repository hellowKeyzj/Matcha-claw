import type { OpenClawConfigRepositoryPort } from '../infrastructure/openclaw-config-repository';
import {
  AGENTS_DEFAULTS_KEY,
  ROUTE_CAPABILITIES,
  applyRouteToAgentsDefaults,
  applyTtsProvider,
  hasAnyMediaRoute,
  isRecord,
  readRouteFromAgentsDefaults,
  readTtsProvider,
  type CapabilityRoutingValue,
} from '../projections/openclaw-capability-routing-service';

export class OpenClawCapabilityRoutingProjectionWorkflow {
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
    return await this.configRepository.updateDirty((config) => {
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
      return { result: undefined, changed: true };
    });
  }
}

function ensureAgentsDefaults(config: Record<string, unknown>): Record<string, unknown> {
  const agents = isRecord(config.agents) ? { ...config.agents } : {};
  const defaults = isRecord(agents.defaults) ? { ...agents.defaults } : {};
  agents.defaults = defaults;
  config.agents = agents;
  return defaults;
}
