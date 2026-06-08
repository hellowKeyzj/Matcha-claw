import type { RuntimeRouteResponse } from '../api/dispatch/runtime-route-dispatcher-types';
import type { AgentRuntimeApplicationService } from '../application/agent-runtime/agent-runtime-application-service';
import type { SessionRuntimeService } from '../application/sessions/service';
import type { ChannelService } from '../application/channels/service';
import type { CapabilityRoutingApplicationService } from '../application/providers/capability-routing-service';
import type { ProviderModelsApplicationService } from '../application/providers/provider-models-service';
import type { ProviderAccountsService } from '../application/providers/accounts';
import type { SettingsService } from '../application/settings/service';
import type { SkillsService } from '../application/skills/service';
import type { ClawHubService } from '../application/skills/clawhub';
import type { SubagentRuntimeService } from '../application/subagents/service';
import type { OpenClawService } from '../application/adapters/openclaw/openclaw-service';
import type { WorkbenchService } from '../application/workbench/service';
import type { RuntimeHostService } from '../application/runtime-host/service';
import type { PluginRuntimeService } from '../application/plugins/plugin-runtime-service';
import type { GatewayService } from '../application/gateway/service';
import type { CronService } from '../application/cron/service';
import type { FileService } from '../application/files/file-service';
import type { LicenseService } from '../application/license/service';
import type { PlatformService } from '../application/platform-runtime/service';
import type { SecurityRuntimeService } from '../application/security/service';
import type { TaskManagerService } from '../application/tasks/service';
import type { ToolchainUvService } from '../application/toolchain/uv-service';

export type RuntimeHostToken<Value> = string & {
  readonly __runtimeHostTokenValue?: Value;
};

export function runtimeHostToken<Value>(key: string): RuntimeHostToken<Value> {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    throw new Error('Runtime host token key is required');
  }
  return normalizedKey as RuntimeHostToken<Value>;
}

export function runtimeHostTokenKey(token: string): string {
  const normalizedKey = token.trim();
  if (!normalizedKey) {
    throw new Error('Runtime host token key is required');
  }
  return normalizedKey;
}

export type RuntimeDispatchRoutePort = (
  method: string,
  route: string,
  payload: unknown,
) => Promise<RuntimeRouteResponse | null>;

export const RUNTIME_DISPATCH_ROUTE_TOKEN = runtimeHostToken<RuntimeDispatchRoutePort>('runtime.dispatchRoute');
export const SETTINGS_SERVICE_TOKEN = runtimeHostToken<SettingsService>('settings.service');
export const PROVIDER_ACCOUNTS_SERVICE_TOKEN = runtimeHostToken<ProviderAccountsService>('providers.accountsService');
export const CAPABILITY_ROUTING_SERVICE_TOKEN = runtimeHostToken<CapabilityRoutingApplicationService>('providers.capabilityRoutingService');
export const PROVIDER_MODELS_SERVICE_TOKEN = runtimeHostToken<ProviderModelsApplicationService>('providers.modelsService');
export const CHANNEL_SERVICE_TOKEN = runtimeHostToken<ChannelService>('channels.service');
export const OPENCLAW_SERVICE_TOKEN = runtimeHostToken<OpenClawService>('openclaw.service');
export const SKILLS_SERVICE_TOKEN = runtimeHostToken<SkillsService>('skills.service');
export const SUBAGENT_SERVICE_TOKEN = runtimeHostToken<SubagentRuntimeService>('subagents.service');
export const CLAWHUB_SERVICE_TOKEN = runtimeHostToken<ClawHubService>('clawhub.service');
export const WORKBENCH_SERVICE_TOKEN = runtimeHostToken<WorkbenchService>('workbench.service');
export const RUNTIME_HOST_SERVICE_TOKEN = runtimeHostToken<RuntimeHostService>('runtimeHost.service');
export const PLUGIN_RUNTIME_SERVICE_TOKEN = runtimeHostToken<PluginRuntimeService>('plugins.runtimeService');
export const GATEWAY_SERVICE_TOKEN = runtimeHostToken<GatewayService>('gateway.service');
export const CRON_SERVICE_TOKEN = runtimeHostToken<CronService>('cron.service');
export const FILE_SERVICE_TOKEN = runtimeHostToken<FileService>('file.service');
export const LICENSE_SERVICE_TOKEN = runtimeHostToken<LicenseService>('license.service');
export const PLATFORM_SERVICE_TOKEN = runtimeHostToken<PlatformService>('platform.service');
export const SECURITY_SERVICE_TOKEN = runtimeHostToken<SecurityRuntimeService>('security.service');
export const TASK_SERVICE_TOKEN = runtimeHostToken<TaskManagerService>('task.service');
export const TOOLCHAIN_UV_SERVICE_TOKEN = runtimeHostToken<ToolchainUvService>('toolchainUv.service');
export const AGENT_RUNTIME_APPLICATION_TOKEN = runtimeHostToken<AgentRuntimeApplicationService>('agentRuntime.application');
export const SESSION_RUNTIME_TOKEN = runtimeHostToken<SessionRuntimeService>('session.runtime');
