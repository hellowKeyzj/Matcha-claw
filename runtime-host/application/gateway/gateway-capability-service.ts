import { unavailable, type ApplicationResponseOf } from '../common/application-response';
import type { GatewayConnectionPort } from './gateway-runtime-port';
import { TASK_SNAPSHOT_TOOL_METHODS } from '../../shared/task-tool-contract';

export const TASK_MANAGER_GATEWAY_PLUGIN = {
  pluginId: 'task-manager',
  methods: [
    ...TASK_SNAPSHOT_TOOL_METHODS,
    'TaskOutput',
    'TaskStop',
  ],
} as const;

export const SUBAGENT_GATEWAY_PLUGIN = {
  pluginId: 'subagents',
  methods: [
    'agents.list',
    'config.get',
    'config.set',
    'agents.create',
    'agents.update',
    'agents.delete',
    'agents.files.get',
    'agents.files.set',
    'agents.files.list',
    'agent.wait',
  ],
} as const;

export interface GatewayPluginCapabilityDefinition {
  readonly pluginId: string;
  readonly methods: readonly string[];
}

export interface PluginCapabilityUnavailable {
  readonly success: false;
  readonly code: 'PLUGIN_CAPABILITY_UNAVAILABLE';
  readonly pluginId: string;
  readonly missingMethods: readonly string[];
  readonly message: string;
}

export interface GatewayPluginCapabilityPort {
  requirePluginMethod(
    definition: GatewayPluginCapabilityDefinition,
    method: string,
    timeoutMs: number,
  ): Promise<ApplicationResponseOf<PluginCapabilityUnavailable> | null>;
}

export class GatewayCapabilityService implements GatewayPluginCapabilityPort {
  constructor(private readonly deps: {
    readonly gateway: Pick<GatewayConnectionPort, 'inspectGatewayMethodReadiness'>;
  }) {}

  async requirePluginMethod(
    definition: GatewayPluginCapabilityDefinition,
    method: string,
    timeoutMs: number,
  ): Promise<ApplicationResponseOf<PluginCapabilityUnavailable> | null> {
    this.assertPluginMethod(definition, method);
    const readiness = await this.deps.gateway.inspectGatewayMethodReadiness([method], timeoutMs);
    if (readiness.ready) {
      return null;
    }
    return unavailable({
      success: false,
      code: 'PLUGIN_CAPABILITY_UNAVAILABLE',
      pluginId: definition.pluginId,
      missingMethods: readiness.missingMethods,
      message: `${definition.pluginId} plugin is not enabled or did not register required Gateway methods.`,
    });
  }

  private assertPluginMethod(definition: GatewayPluginCapabilityDefinition, method: string): void {
    if (!definition.methods.includes(method)) {
      throw new Error(`Unsupported ${definition.pluginId} Gateway method: ${method}`);
    }
  }
}
