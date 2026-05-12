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
    }, ['status', 'TaskList'])).toEqual({
      ready: false,
      methods: ['status', 'TaskList'],
      missingMethods: ['TaskList'],
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
          methods: ['TaskList'],
          missingMethods: ['TaskList'],
        }),
      },
    });

    await expect(service.requirePluginMethod(
      TASK_MANAGER_GATEWAY_PLUGIN,
      'TaskList',
      5000,
    )).resolves.toEqual({
      status: 503,
      data: {
        success: false,
        code: 'PLUGIN_CAPABILITY_UNAVAILABLE',
        pluginId: 'task-manager',
        missingMethods: ['TaskList'],
        message: 'task-manager plugin is not enabled or did not register required Gateway methods.',
      },
    });
  });

  it('rejects methods outside a registered plugin capability contract', async () => {
    const service = new GatewayCapabilityService({
      gateway: {
        inspectGatewayMethodReadiness: async () => ({
          ready: true,
          methods: ['TaskList'],
          missingMethods: [],
        }),
      },
    });

    await expect(service.requirePluginMethod(
      SUBAGENT_GATEWAY_PLUGIN,
      'TaskList',
      5000,
    )).rejects.toThrow('Unsupported subagents Gateway method: TaskList');
  });
});
