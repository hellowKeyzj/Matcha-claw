import { describe, expect, it } from 'vitest';
import {
  GatewayPluginStateLedger,
  InMemoryAuditSink,
  LocalPluginStateLedger,
  ToolReconciler,
  ToolRegistryStore,
} from '@electron/adapters/platform';

describe('reconciler ledger', () => {
  it('marks local-only tools as missing and gateway-only tools as discovered', async () => {
    const gatewayLedger = new GatewayPluginStateLedger();
    const localLedger = new LocalPluginStateLedger();
    const registry = new ToolRegistryStore();
    const audit = new InMemoryAuditSink();
    const reconciler = new ToolReconciler(gatewayLedger, localLedger, registry, audit);

    gatewayLedger.setAll([{ id: 'native-1', source: 'native', enabled: true }]);
    localLedger.setAll([{ id: 'local-1', source: 'platform', enabled: true }]);

    const report = await reconciler.reconcileTools();
    expect(report.discovered.map((tool) => tool.id)).toContain('native-1');
    expect(report.missing.map((tool) => tool.id)).toContain('local-1');
    expect(audit.snapshot()).toHaveLength(1);
  });
});
