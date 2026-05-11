import { InMemoryAuditSink } from '../../application/platform-runtime/audit-sink';
import { ContextAssembler } from '../../application/platform-runtime/context-assembler';
import { LocalEventBus } from '../../application/platform-runtime/local-event-bus';
import { OpenClawRuntimeDriver, type OpenClawRuntimeBridge } from '../../application/platform-runtime/openclaw-runtime-driver';
import type { RuntimeHostPlatformFacade } from '../../application/platform-runtime/platform-runtime-port';
import { PolicyEngine } from '../../application/platform-runtime/policy-engine';
import { RunSessionService } from '../../application/platform-runtime/run-session-service';
import { RuntimeManagerService } from '../../application/platform-runtime/runtime-manager-service';
import { GatewayPluginStateLedger } from '../../application/platform-runtime/state/gateway-plugin-state-ledger';
import { LocalPluginStateLedger } from '../../application/platform-runtime/state/local-plugin-state-ledger';
import { ToolRegistryStore } from '../../application/platform-runtime/state/tool-registry-store';
import { ToolCatalogService } from '../../application/platform-runtime/tool-catalog-service';
import { PlatformToolExecutor } from '../../application/platform-runtime/tool-executor';
import { ToolReconciler } from '../../application/platform-runtime/tool-reconciler';
import type { RuntimeClockPort, RuntimeIdGeneratorPort } from '../../application/common/runtime-ports';
import type { RuntimeHostContainer } from '../container';

export interface RuntimeHostPlatformRoot {
  readonly facade: RuntimeHostPlatformFacade;
  readonly toolRegistry: ToolRegistryStore;
  readonly runtimeManager: RuntimeManagerService;
  readonly runSessionService: RunSessionService;
  readonly toolCatalogService: ToolCatalogService;
  readonly toolExecutor: PlatformToolExecutor;
}

export function registerRuntimeHostPlatformRoot(
  container: RuntimeHostContainer,
  openclawBridge: () => OpenClawRuntimeBridge,
): void {
  container.register('platform.runtimeDriver', (scope) => new OpenClawRuntimeDriver(
    openclawBridge(),
    scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
  ));
  container.register('platform.toolRegistry', () => new ToolRegistryStore());
  container.register('platform.gatewayLedger', () => new GatewayPluginStateLedger());
  container.register('platform.localLedger', () => new LocalPluginStateLedger());
  container.register('platform.policyEngine', () => new PolicyEngine());
  container.register('platform.auditSink', () => new InMemoryAuditSink());
  container.register('platform.eventBus', () => new LocalEventBus());
  container.register('platform.contextAssembler', (scope) => new ContextAssembler(
    scope.resolve('platform.toolRegistry'),
    scope.resolve('platform.policyEngine'),
  ));
  container.register('platform.toolExecutor', () => new PlatformToolExecutor());
  container.register('platform.reconciler', (scope) => new ToolReconciler(
    scope.resolve('platform.gatewayLedger'),
    scope.resolve('platform.localLedger'),
    scope.resolve('platform.toolRegistry'),
    scope.resolve('platform.auditSink'),
    scope.resolve<RuntimeClockPort>('runtime.clock'),
  ));
  container.register('platform.runtimeManager', (scope) => new RuntimeManagerService(
    scope.resolve('platform.runtimeDriver'),
    scope.resolve('platform.toolRegistry'),
    scope.resolve('platform.auditSink'),
    scope.resolve('platform.reconciler'),
    scope.resolve<RuntimeClockPort>('runtime.clock'),
  ));
  container.register('platform.runSessionService', (scope) => new RunSessionService(
    scope.resolve('platform.contextAssembler'),
    scope.resolve('platform.runtimeDriver'),
    scope.resolve('platform.eventBus'),
    scope.resolve('platform.auditSink'),
    scope.resolve<RuntimeClockPort>('runtime.clock'),
  ));
  container.register('platform.toolCatalogService', (scope) => new ToolCatalogService(
    scope.resolve('platform.toolRegistry'),
    scope.resolve('platform.auditSink'),
    scope.resolve<RuntimeClockPort>('runtime.clock'),
  ));
  container.register('platform.facade', (scope) => createRuntimeHostPlatformFacade({
    runtimeDriver: scope.resolve('platform.runtimeDriver'),
    toolRegistry: scope.resolve('platform.toolRegistry'),
    gatewayLedger: scope.resolve('platform.gatewayLedger'),
    localLedger: scope.resolve('platform.localLedger'),
    auditSink: scope.resolve('platform.auditSink'),
    reconciler: scope.resolve('platform.reconciler'),
    runtimeManager: scope.resolve('platform.runtimeManager'),
    runSessionService: scope.resolve('platform.runSessionService'),
    toolCatalogService: scope.resolve('platform.toolCatalogService'),
    toolExecutor: scope.resolve('platform.toolExecutor'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
}

export function resolveRuntimeHostPlatformRoot(container: RuntimeHostContainer): RuntimeHostPlatformRoot {
  return {
    facade: container.resolve('platform.facade'),
    toolRegistry: container.resolve('platform.toolRegistry'),
    runtimeManager: container.resolve('platform.runtimeManager'),
    runSessionService: container.resolve('platform.runSessionService'),
    toolCatalogService: container.resolve('platform.toolCatalogService'),
    toolExecutor: container.resolve('platform.toolExecutor'),
  };
}

function createRuntimeHostPlatformFacade(deps: {
  readonly runtimeDriver: OpenClawRuntimeDriver;
  readonly toolRegistry: ToolRegistryStore;
  readonly gatewayLedger: GatewayPluginStateLedger;
  readonly localLedger: LocalPluginStateLedger;
  readonly auditSink: InMemoryAuditSink;
  readonly reconciler: ToolReconciler;
  readonly runtimeManager: RuntimeManagerService;
  readonly runSessionService: RunSessionService;
  readonly toolCatalogService: ToolCatalogService;
  readonly toolExecutor: PlatformToolExecutor;
  readonly clock: RuntimeClockPort;
}): RuntimeHostPlatformFacade {
  return {
    async runtimeHealth() {
      return await deps.runtimeManager.runtimeHealth();
    },

    async installNativeTool(source) {
      const toolId = await deps.runtimeManager.installNativeTool(source);
      const installed = await deps.runtimeDriver.listInstalledTools();
      deps.gatewayLedger.setAll(installed);
      return toolId;
    },

    async reconcileNativeTools() {
      const report = await deps.runtimeManager.reconcileNativeTools();
      deps.gatewayLedger.setAll(await deps.runtimeDriver.listInstalledTools());
      return report;
    },

    async startRun(req, eventTx) {
      return await deps.runSessionService.start(req, eventTx);
    },

    async abortRun(runId) {
      await deps.runSessionService.abort(runId);
    },

    async listEffectiveTools(query = {}) {
      return await deps.toolCatalogService.listEffective(query);
    },

    async upsertPlatformTools(tools) {
      await deps.toolCatalogService.upsertPlatformTools(tools);
      deps.localLedger.setAll(deps.toolRegistry.snapshotPlatform());
    },

    async setToolEnabled(toolId, enabled) {
      if (enabled) {
        await deps.runtimeDriver.enableTool(toolId);
      } else {
        await deps.runtimeDriver.disableTool(toolId);
      }
      const upstream = await deps.runtimeDriver.listInstalledTools();
      deps.gatewayLedger.setAll(upstream);
      await deps.toolRegistry.upsertNative(upstream);
      await deps.auditSink.append({
        type: 'runtime.set_tool_enabled',
        ts: deps.clock.nowMs(),
        payload: { toolId, enabled },
      });
    },

    async executePlatformTool(req) {
      return await deps.toolExecutor.executeTool(req);
    },
  };
}
