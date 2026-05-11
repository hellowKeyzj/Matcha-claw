import { describe, expect, it } from 'vitest';
import {
  GatewayCapabilityService,
  TASK_MANAGER_GATEWAY_PLUGIN,
  SUBAGENT_GATEWAY_PLUGIN,
} from '../../runtime-host/application/gateway/gateway-capability-service';
import {
  inspectGatewayMethods,
  normalizeGatewayMethods,
} from '../../runtime-host/application/gateway/gateway-runtime-port';

describe('gateway capabilities', () => {
  it('normalizes hello-ok method lists into a unique method surface', () => {
    expect(normalizeGatewayMethods([' status ', '', 'status', 'config.get', 1])).toEqual([
      'status',
      'config.get',
    ]);
  });

  it('reports missing required gateway methods from the advertised method surface', () => {
    expect(inspectGatewayMethods({
      methods: ['status', 'config.get'],
      updatedAt: 123,
    }, ['status', 'task_manager.list'])).toEqual({
      ready: false,
      methods: ['status', 'task_manager.list'],
      missingMethods: ['task_manager.list'],
      capabilities: {
        methods: ['status', 'config.get'],
        updatedAt: 123,
      },
    });
  });

  it('returns structured plugin capability errors before calling plugin RPC methods', async () => {
    const service = new GatewayCapabilityService({
      gateway: {
        inspectGatewayMethodReadiness: async () => ({
          ready: false,
          methods: ['task_manager.list'],
          missingMethods: ['task_manager.list'],
        }),
      },
    });

    await expect(service.requirePluginMethod(
      TASK_MANAGER_GATEWAY_PLUGIN,
      'task_manager.list',
      5000,
    )).resolves.toEqual({
      status: 503,
      data: {
        success: false,
        code: 'PLUGIN_CAPABILITY_UNAVAILABLE',
        pluginId: 'task-manager',
        missingMethods: ['task_manager.list'],
        message: 'task-manager plugin is not enabled or did not register required Gateway methods.',
      },
    });
  });

  it('rejects methods outside a registered plugin capability contract', async () => {
    const service = new GatewayCapabilityService({
      gateway: {
        inspectGatewayMethodReadiness: async () => ({
          ready: true,
          methods: ['task_manager.list'],
          missingMethods: [],
        }),
      },
    });

    await expect(service.requirePluginMethod(
      SUBAGENT_GATEWAY_PLUGIN,
      'task_manager.list',
      5000,
    )).rejects.toThrow('Unsupported subagents Gateway method: task_manager.list');
  });
});
