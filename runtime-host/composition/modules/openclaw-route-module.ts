import { channelRoutes } from '../../api/routes/channel-routes';
import { capabilityRoutingRoutes } from '../../api/routes/capability-routing-routes';
import { providerModelsRoutes } from '../../api/routes/provider-models-routes';
import { clawHubRoutes } from '../../api/routes/clawhub-routes';
import { openClawRoutes } from '../../api/routes/openclaw-routes';
import { providerRoutes } from '../../api/routes/provider-routes';
import { settingsRoutes } from '../../api/routes/settings-routes';
import { skillsRoutes } from '../../api/routes/skills-routes';
import { subagentRoutes } from '../../api/routes/subagent-routes';
import type { RuntimeHostRouteRegistry } from '../route-registry';
import type { ChannelService } from '../../application/channels/service';
import type { CapabilityRoutingApplicationService } from '../../application/providers/capability-routing-service';
import type { ProviderModelsApplicationService } from '../../application/providers/provider-models-service';
import type { ProviderAccountsService } from '../../application/providers/accounts';
import type { SettingsService } from '../../application/settings/service';
import type { SkillsService } from '../../application/skills/service';
import type { ClawHubService } from '../../application/skills/clawhub';
import type { SubagentRuntimeService } from '../../application/subagents/service';
import type { OpenClawService } from '../../application/adapters/openclaw/openclaw-service';

export interface OpenClawRouteServices {
  readonly settingsService: SettingsService;
  readonly providerAccountsService: ProviderAccountsService;
  readonly capabilityRoutingService: CapabilityRoutingApplicationService;
  readonly providerModelsService: ProviderModelsApplicationService;
  readonly channelService: ChannelService;
  readonly openClawService: OpenClawService;
  readonly skillsService: SkillsService;
  readonly subagentService: SubagentRuntimeService;
  readonly clawHubService: ClawHubService;
}

export function registerOpenClawRoutes(
  routes: RuntimeHostRouteRegistry,
  services: OpenClawRouteServices,
): void {

  routes.registerDefinitions('settings', settingsRoutes, { settingsService: services.settingsService });
  routes.registerDefinitions('provider', providerRoutes, { providerAccountsService: services.providerAccountsService });
  routes.registerDefinitions('capabilityRouting', capabilityRoutingRoutes, { capabilityRoutingService: services.capabilityRoutingService });
  routes.registerDefinitions('providerModels', providerModelsRoutes, { providerModelsService: services.providerModelsService });
  routes.registerDefinitions('channel', channelRoutes, { channelService: services.channelService });
  routes.registerDefinitions('openclaw', openClawRoutes, { openClawService: services.openClawService });
  routes.registerDefinitions('skills', skillsRoutes, { skillsService: services.skillsService });
  routes.registerDefinitions('subagents', subagentRoutes, { subagentService: services.subagentService });
  routes.registerDefinitions('clawhub', clawHubRoutes, { clawHubService: services.clawHubService });
}
