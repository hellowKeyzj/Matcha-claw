import {
  REFRESH_PLUGIN_CATALOG_JOB,
  SET_ENABLED_PLUGINS_JOB,
  createPluginRuntimeJobPort,
  type SetEnabledPluginsJobPayload,
  type PluginRuntimeJobPort,
} from '../../application/plugins/plugin-runtime-jobs';
import {
  RuntimePluginRegistry,
  parseFallbackEnabledPluginIds,
  parseInjectedPluginCatalog,
} from '../../application/plugins/runtime-plugin-registry';
import { ManagedPluginInstaller } from '../../application/plugins/managed-plugin-installer';
import { PluginCompanionSkillService } from '../../application/plugins/plugin-companion-skill-service';
import { RuntimePluginLifecycleRunner } from '../../application/plugins/plugin-lifecycle-registry';
import { RuntimePluginRepository } from '../../application/plugins/runtime-plugin-service';
import { NodePluginFileSystem } from '../plugin-file-system-adapter';
import {
  registerRuntimeJobDefinitions,
  type RuntimeJobDefinition,
  type RuntimeJobRegistry,
} from '../../core/jobs';
import {
  registerRuntimeLifecycleDefinitions,
  type RuntimeHostLifecycle,
} from '../../core/lifecycle';
import type { RuntimeHostLogger } from '../../shared/logger';
import type {
  RuntimeLongTaskLookupPort,
  RuntimeLongTaskSubmissionPort,
} from '../../application/runtime-host/runtime-task-ports';
import type { GatewayControlPort } from '../../application/runtime-host/parent-shell-port';
import type { OpenClawConfigRepositoryPort } from '../../application/openclaw/openclaw-config-repository';
import type { OpenClawEnvironmentRepository } from '../../application/openclaw/openclaw-environment-repository';
import type { RuntimeHostContainer } from '../container';

export interface PluginRuntimeModule {
  readonly pluginRegistry: RuntimePluginRegistry;
}

export function registerPluginRuntimeModule(container: RuntimeHostContainer, deps: {
  readonly lifecycle: RuntimeHostLifecycle;
  readonly logger: RuntimeHostLogger;
  readonly enabledPluginIdsEnv: string | undefined;
  readonly pluginCatalogEnv: string | undefined;
}): void {
  container.register('plugins.fileSystem', () => new NodePluginFileSystem());
  container.register('plugins.companionSkillService', (scope) => new PluginCompanionSkillService(
    scope.resolve('openclaw.environmentRepository'),
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
    scope.resolve('plugins.fileSystem'),
  ));
  container.register('plugins.managedInstaller', (scope) => new ManagedPluginInstaller(
    scope.resolve('openclaw.environmentRepository'),
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
    scope.resolve('plugins.companionSkillService'),
    scope.resolve('plugins.fileSystem'),
  ));
  container.register('plugins.lifecycleRunner', (scope) => new RuntimePluginLifecycleRunner(
    scope.resolve('plugins.companionSkillService'),
  ));
  container.register('plugins.repository', (scope) => new RuntimePluginRepository(
    scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
    scope.resolve('plugins.managedInstaller'),
    scope.resolve('plugins.lifecycleRunner'),
    scope.resolve('plugins.fileSystem'),
  ));
  container.register('plugins.runtimeJobs', (scope): PluginRuntimeJobPort => createPluginRuntimeJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
    scope.resolve<RuntimeLongTaskLookupPort>('runtime.taskLookup'),
  ));
  container.register('plugins.registry', (scope) => {
    return new RuntimePluginRegistry({
      fallbackEnabledPluginIds: parseFallbackEnabledPluginIds(deps.enabledPluginIdsEnv),
      injectedPluginCatalog: parseInjectedPluginCatalog(deps.pluginCatalogEnv),
      getLifecycleState: () => deps.lifecycle.getState(),
      logger: deps.logger,
      jobs: scope.resolve<PluginRuntimeJobPort>('plugins.runtimeJobs'),
      repository: scope.resolve('plugins.repository'),
    });
  });
}

export function resolvePluginRuntimeModule(container: RuntimeHostContainer): PluginRuntimeModule {
  return {
    pluginRegistry: container.resolve('plugins.registry'),
  };
}

export function registerPluginRuntimeJobs(
  module: PluginRuntimeModule,
  deps: {
    readonly jobRegistry: RuntimeJobRegistry;
    readonly gatewayControl: GatewayControlPort;
  },
): void {
  registerRuntimeJobDefinitions(deps.jobRegistry, createPluginRuntimeJobDefinitions(module, deps));
}

function createPluginRuntimeJobDefinitions(
  module: PluginRuntimeModule,
  deps: {
    readonly gatewayControl: GatewayControlPort;
  },
): readonly RuntimeJobDefinition[] {
  return [
    {
      type: REFRESH_PLUGIN_CATALOG_JOB,
      handler: async () => {
        await module.pluginRegistry.refreshNow();
      },
    },
    {
      type: SET_ENABLED_PLUGINS_JOB,
      handler: async (payload) => {
        const body = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? payload as Partial<SetEnabledPluginsJobPayload>
          : {};
        const pluginIds = Array.isArray(body.pluginIds)
          ? body.pluginIds.filter((pluginId): pluginId is string => typeof pluginId === 'string')
          : [];
        return await module.pluginRegistry.executeSetEnabledPluginIds(
          pluginIds,
          deps.gatewayControl,
        );
      },
    },
  ];
}

export function registerPluginRuntimeLifecycle(
  module: PluginRuntimeModule,
  deps: {
    readonly lifecycle: RuntimeHostLifecycle;
  },
): void {
  registerRuntimeLifecycleDefinitions(deps.lifecycle, {
    backgroundServices: [
      {
        name: 'plugins.catalog-refresh',
        start: () => {
          module.pluginRegistry.enqueueRefresh();
        },
      },
    ],
  });
}
