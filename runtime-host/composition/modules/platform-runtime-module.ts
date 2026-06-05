import { InMemoryAuditSink } from '../../application/platform-runtime/audit-sink';
import { ContextAssembler } from '../../application/platform-runtime/context-assembler';
import { LocalEventBus } from '../../application/platform-runtime/local-event-bus';
import type { RuntimeHostPlatformFacade } from '../../application/platform-runtime/platform-runtime-port';
import type { GatewayRuntimePort } from '../../application/gateway/gateway-runtime-port';
import type { AgentRuntimeDriver } from '../../shared/platform-runtime-contracts';
import { PolicyEngine } from '../../application/platform-runtime/policy-engine';
import { RunSessionService } from '../../application/platform-runtime/run-session-service';
import { RuntimeManagerService } from '../../application/platform-runtime/runtime-manager-service';
import { GatewayPluginStateLedger } from '../../application/platform-runtime/state/gateway-plugin-state-ledger';
import { LocalPluginStateLedger } from '../../application/platform-runtime/state/local-plugin-state-ledger';
import { ToolRegistryStore } from '../../application/platform-runtime/state/tool-registry-store';
import { ToolCatalogService } from '../../application/platform-runtime/tool-catalog-service';
import { PlatformToolExecutor } from '../../application/platform-runtime/tool-executor';
import { ToolReconciler } from '../../application/platform-runtime/tool-reconciler';
import { PlatformNativeToolWorkflow } from '../../application/workflows/platform-runtime/platform-native-tool-workflow';
import { PlatformRunSessionWorkflow } from '../../application/workflows/platform-runtime/platform-run-session-workflow';
import { PlatformToolStateWorkflow } from '../../application/workflows/platform-runtime/platform-tool-state-workflow';
import type { RuntimeClockPort } from '../../application/common/runtime-ports';
import type { RuntimeHostContainer } from '../container';

export interface RuntimeHostPlatformRoot {
  readonly facade: RuntimeHostPlatformFacade;
  readonly toolRegistry: ToolRegistryStore;
  readonly runtimeManager: RuntimeManagerService;
  readonly runSessionService: RunSessionService;
  readonly toolCatalogService: ToolCatalogService;
  readonly toolExecutor: PlatformToolExecutor;
}

export interface AgentRuntimeDriverFactoryPort {
  createRuntimeDriver(gateway: GatewayRuntimePort): AgentRuntimeDriver;
}

export function registerRuntimeHostPlatformRoot(
  container: RuntimeHostContainer,
): void {
  container.register('platform.toolRegistry', () => new ToolRegistryStore());
  container.register('platform.gatewayLedger', () => new GatewayPluginStateLedger());
  container.register('platform.localLedger', () => new LocalPluginStateLedger());
  container.register('platform.policyEngine', () => new PolicyEngine());
  container.register('platform.auditSink', () => new InMemoryAuditSink());
  container.register('platform.eventBus', () => new LocalEventBus());
  container.register('platform.runtimeDriver', (scope) => scope.resolve<AgentRuntimeDriverFactoryPort>('platform.runtimeDriverFactory').createRuntimeDriver(
    scope.resolve<GatewayRuntimePort>('gateway.runtime'),
  ));
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
  container.register('platform.nativeToolWorkflow', (scope) => new PlatformNativeToolWorkflow({
    runtimeDriver: scope.resolve('platform.runtimeDriver'),
    toolRegistry: scope.resolve('platform.toolRegistry'),
    auditSink: scope.resolve('platform.auditSink'),
    reconciler: scope.resolve('platform.reconciler'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('platform.runtimeManager', (scope) => new RuntimeManagerService(
    scope.resolve('platform.runtimeDriver'),
    scope.resolve<PlatformNativeToolWorkflow>('platform.nativeToolWorkflow'),
  ));
  container.register('platform.runSessionWorkflow', (scope) => new PlatformRunSessionWorkflow({
    contextAssembler: scope.resolve('platform.contextAssembler'),
    runtimeDriver: scope.resolve('platform.runtimeDriver'),
    eventBus: scope.resolve('platform.eventBus'),
    auditSink: scope.resolve('platform.auditSink'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('platform.runSessionService', (scope) => new RunSessionService(
    scope.resolve<PlatformRunSessionWorkflow>('platform.runSessionWorkflow'),
  ));
  container.register('platform.toolCatalogService', (scope) => new ToolCatalogService(
    scope.resolve('platform.toolRegistry'),
    scope.resolve('platform.auditSink'),
    scope.resolve<RuntimeClockPort>('runtime.clock'),
  ));
  container.register('platform.toolStateWorkflow', (scope) => new PlatformToolStateWorkflow({
    runtimeDriver: scope.resolve('platform.runtimeDriver'),
    gatewayLedger: scope.resolve('platform.gatewayLedger'),
    localLedger: scope.resolve('platform.localLedger'),
    toolRegistry: scope.resolve('platform.toolRegistry'),
    auditSink: scope.resolve('platform.auditSink'),
    nativeToolWorkflow: scope.resolve<PlatformNativeToolWorkflow>('platform.nativeToolWorkflow'),
    toolCatalogService: scope.resolve('platform.toolCatalogService'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('platform.facade', (scope) => createRuntimeHostPlatformFacade({
    toolStateWorkflow: scope.resolve('platform.toolStateWorkflow'),
    runtimeManager: scope.resolve('platform.runtimeManager'),
    runSessionService: scope.resolve('platform.runSessionService'),
    toolCatalogService: scope.resolve('platform.toolCatalogService'),
    toolExecutor: scope.resolve('platform.toolExecutor'),
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
  readonly toolStateWorkflow: PlatformToolStateWorkflow;
  readonly runtimeManager: RuntimeManagerService;
  readonly runSessionService: RunSessionService;
  readonly toolCatalogService: ToolCatalogService;
  readonly toolExecutor: PlatformToolExecutor;
}): RuntimeHostPlatformFacade {
  return {
    async runtimeHealth() {
      return await deps.runtimeManager.runtimeHealth();
    },

    async installNativeTool(source) {
      return await deps.toolStateWorkflow.installNativeTool(source);
    },

    async reconcileNativeTools() {
      return await deps.toolStateWorkflow.reconcileNativeTools();
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
      await deps.toolStateWorkflow.upsertPlatformTools(tools);
    },

    async setToolEnabled(toolId, enabled) {
      await deps.toolStateWorkflow.setToolEnabled(toolId, enabled);
    },

    async executePlatformTool(req) {
      return await deps.toolExecutor.executeTool(req);
    },
  };
}
