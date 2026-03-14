import type { AuditSinkPort, ReconcileReport, ReconcilerPort, ToolDefinition, ToolRegistryPort } from '../../core/contracts';
import type { GatewayPluginStateLedger, LocalPluginStateLedger } from './ledger';

function collectById(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    map.set(tool.id, tool);
  }
  return map;
}

function isConflict(a: ToolDefinition, b: ToolDefinition): boolean {
  return (a.version ?? '') !== (b.version ?? '') || (a.enabled ?? true) !== (b.enabled ?? true);
}

export class ToolReconciler implements ReconcilerPort {
  constructor(
    private readonly gatewayLedger: GatewayPluginStateLedger,
    private readonly localLedger: LocalPluginStateLedger,
    private readonly toolRegistry: ToolRegistryPort,
    private readonly auditSink: AuditSinkPort,
  ) {}

  async reconcileTools(): Promise<ReconcileReport> {
    const gatewayTools = this.gatewayLedger.list();
    const localTools = this.localLedger.list();

    const gatewayMap = collectById(gatewayTools);
    const localMap = collectById(localTools);

    const discovered: ToolDefinition[] = [];
    const missing: ToolDefinition[] = [];
    const conflicts: ToolDefinition[] = [];

    for (const [toolId, gatewayTool] of gatewayMap) {
      if (!localMap.has(toolId)) {
        discovered.push(gatewayTool);
        continue;
      }
      const localTool = localMap.get(toolId)!;
      if (isConflict(gatewayTool, localTool)) {
        conflicts.push(gatewayTool);
      }
    }

    for (const [toolId, localTool] of localMap) {
      if (!gatewayMap.has(toolId)) {
        missing.push(localTool);
      }
    }

    if (discovered.length > 0) {
      await this.toolRegistry.upsertNative(discovered);
    }

    if (missing.length > 0 || conflicts.length > 0) {
      await this.auditSink.append({
        type: 'tool.reconcile.alert',
        ts: Date.now(),
        payload: {
          missing: missing.map((tool) => tool.id),
          conflicts: conflicts.map((tool) => tool.id),
        },
      });
    }

    return { discovered, missing, conflicts };
  }
}
