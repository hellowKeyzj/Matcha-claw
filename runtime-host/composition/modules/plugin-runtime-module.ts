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
  type InjectedPluginCatalogPlatformPolicyPort,
} from '../../application/plugins/runtime-plugin-registry';
import { PluginCompanionSkillService, type PluginCompanionSkillWorkspacePort } from '../../application/plugins/plugin-companion-skill-service';
import { RuntimePluginLifecycleRunner } from '../../application/plugins/plugin-lifecycle-registry';
import { PluginCompanionSkillWorkflow } from '../../application/workflows/plugin-lifecycle/plugin-companion-skill-workflow';
import { RuntimePluginLifecycleWorkflow } from '../../application/workflows/plugin-lifecycle/runtime-plugin-lifecycle-workflow';
import type { ManagedPluginCatalogPort, ManagedPluginInstallerPort } from '../../application/plugins/managed-plugin-catalog';
import { RuntimePluginRepository, type PluginRuntimePort, type RuntimePluginCatalogProjectionPort, type RuntimePluginConfigProjectionPort } from '../../application/plugins/runtime-plugin-service';
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
import type { RuntimePluginConfigStorePort } from '../../application/plugins/runtime-plugin-service';
import type { RuntimeHostContainer } from '../container';

export interface PluginRuntimeModule {
  readonly pluginRegistry: RuntimePluginRegistry;
}

export function registerPluginRuntimeModule(container: RuntimeHostContainer, deps: {
  readonly lifecycle: RuntimeHostLifecycle;
  readonly logger: RuntimeHostLogger;
  readonly enabledPluginIdsEnv: string | undefined;
  readonly pluginCatalogEnv: string | undefined;
  readonly injectedPluginPlatformPolicy: InjectedPluginCatalogPlatformPolicyPort;
}): void {
  container.register('plugins.companionSkillWorkflow', (scope) => new PluginCompanionSkillWorkflow({
    workspace: scope.resolve<PluginCompanionSkillWorkspacePort>('plugins.companionSkillWorkspace'),
    fileSystem: scope.resolve('plugins.fileSystem'),
    managedPluginCatalog: scope.resolve<ManagedPluginCatalogPort>('plugins.managedCatalog'),
  }));
  container.register('plugins.companionSkillService', (scope) => new PluginCompanionSkillService(
    scope.resolve<PluginCompanionSkillWorkflow>('plugins.companionSkillWorkflow'),
  ));
  container.register('plugins.lifecycleRunner', (scope) => new RuntimePluginLifecycleRunner(
    scope.resolve('plugins.companionSkillService'),
  ));
  container.register('plugins.lifecycleWorkflow', (scope) => new RuntimePluginLifecycleWorkflow({
    configRepository: scope.resolve<RuntimePluginConfigStorePort>('plugins.configStore'),
    configProjection: scope.resolve<RuntimePluginConfigProjectionPort>('plugins.configProjection'),
    catalogProjection: scope.resolve<RuntimePluginCatalogProjectionPort>('plugins.catalogProjection'),
    installer: scope.resolve<ManagedPluginInstallerPort>('plugins.managedInstaller'),
    managedPluginCatalog: scope.resolve<ManagedPluginCatalogPort>('plugins.managedCatalog'),
    lifecycleRunner: scope.resolve('plugins.lifecycleRunner'),
  }));
  container.register('plugins.repository', (scope) => new RuntimePluginRepository(
    scope.resolve<RuntimePluginLifecycleWorkflow>('plugins.lifecycleWorkflow'),
  ));
  container.register('plugins.runtimeJobs', (scope): PluginRuntimeJobPort => createPluginRuntimeJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
    scope.resolve<RuntimeLongTaskLookupPort>('runtime.taskLookup'),
  ));
  container.register('plugins.registry', (scope) => {
    return new RuntimePluginRegistry({
      fallbackEnabledPluginIds: parseFallbackEnabledPluginIds(deps.enabledPluginIdsEnv),
      injectedPluginCatalog: parseInjectedPluginCatalog(deps.pluginCatalogEnv, deps.injectedPluginPlatformPolicy),
      getLifecycleState: () => deps.lifecycle.getState(),
      logger: deps.logger,
      jobs: scope.resolve<PluginRuntimeJobPort>('plugins.runtimeJobs'),
      repository: scope.resolve('plugins.repository'),
    });
  });
  container.register('plugins.runtime', (scope): PluginRuntimePort => {
    const registry = scope.resolve<RuntimePluginRegistry>('plugins.registry');
    return {
      snapshotPluginsRuntimePayload: () => registry.snapshotPluginsRuntimePayload(),
      enqueueRefresh: () => registry.enqueueRefresh(),
      getEnabledPluginIds: () => registry.getEnabledPluginIds(),
      getPluginCatalog: () => registry.getPluginCatalog(),
      getRefreshJob: () => registry.getRefreshJob(),
    };
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
