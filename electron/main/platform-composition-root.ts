import type { HostEventBus } from '../api/event-bus';
import type { GatewayManager } from '../gateway/manager';
import { RunSessionService, ToolCatalogService } from '../core/application';
import {
  ContextAssembler,
  LocalEventBus,
  LoggerAuditSink,
  PlatformToolExecutor,
  PolicyEngine,
  RuntimeManagerAdapter,
  ToolReconciler,
  ToolRegistryStore,
} from '../adapters/platform';
import { GatewayPluginStateLedger, LocalPluginStateLedger } from '../adapters/platform/ledger';
import { OpenClawRuntimeDriver } from '../adapters/openclaw';
import { PlatformIpcFacade, type PlatformRuntimeFacade } from './platform-ipc-facade';

export interface PlatformCompositionRoot {
  facade: PlatformRuntimeFacade;
  runtimeDriver: OpenClawRuntimeDriver;
  toolRegistry: ToolRegistryStore;
  runtimeManager: RuntimeManagerAdapter;
  runSessionService: RunSessionService;
  toolCatalogService: ToolCatalogService;
  toolExecutor: PlatformToolExecutor;
}

export function buildPlatformCompositionRoot(input: {
  gatewayManager: GatewayManager;
  hostEventBus?: HostEventBus;
}): PlatformCompositionRoot {
  const runtimeDriver = new OpenClawRuntimeDriver({
    rpc: (method, params, timeoutMs) => input.gatewayManager.rpc(method, params, timeoutMs),
    getStatus: () => input.gatewayManager.getStatus(),
  });

  const toolRegistry = new ToolRegistryStore();
  const gatewayLedger = new GatewayPluginStateLedger();
  const localLedger = new LocalPluginStateLedger();
  const policyEngine = new PolicyEngine();
  const auditSink = new LoggerAuditSink();
  const eventBus = new LocalEventBus();
  const contextAssembler = new ContextAssembler(toolRegistry, policyEngine);
  const toolExecutor = new PlatformToolExecutor();
  const reconciler = new ToolReconciler(gatewayLedger, localLedger, toolRegistry, auditSink);
  const runtimeManager = new RuntimeManagerAdapter(
    runtimeDriver,
    toolRegistry,
    gatewayLedger,
    reconciler,
    auditSink,
  );
  const runSessionService = new RunSessionService(
    contextAssembler,
    runtimeDriver,
    eventBus,
    auditSink,
  );
  const toolCatalogService = new ToolCatalogService(toolRegistry, auditSink);

  if (input.hostEventBus) {
    eventBus.subscribe((event) => {
      input.hostEventBus!.emit('platform:event', event);
    });
  }

  const facade = new PlatformIpcFacade(
    runtimeManager,
    runSessionService,
    toolCatalogService,
    toolExecutor,
    localLedger,
    toolRegistry,
  );

  return {
    facade,
    runtimeDriver,
    toolRegistry,
    runtimeManager,
    runSessionService,
    toolCatalogService,
    toolExecutor,
  };
}
