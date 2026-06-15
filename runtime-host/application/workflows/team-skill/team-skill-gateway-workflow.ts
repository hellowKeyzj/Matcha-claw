import { badRequest, ok, type ApplicationResponseOf } from '../../common/application-response';
import type { GatewayPluginCapabilityPort, GatewayPluginCapabilityDefinition } from '../../gateway/gateway-capability-service';
import type { GatewayRpcPort } from '../../gateway/gateway-runtime-port';

const TEAM_RUNTIME_RPC_TIMEOUT_MS = 60_000;
const TEAM_RUNTIME_CAPABILITY_TIMEOUT_MS = 5_000;

export type TeamRuntimeOperationId =
  | 'team.packageValidate'
  | 'team.dependencyPlan'
  | 'team.runCreate'
  | 'team.runStart'
  | 'team.runSnapshot'
  | 'team.runDiagnostics'
  | 'team.runDecisionSubmit'
  | 'team.planWorkflow'
  | 'team.runTick'
  | 'team.approvalResolve'
  | 'team.runCancel'
  | 'team.runDelete';

const TEAM_RUNTIME_OPERATION_METHODS: Record<TeamRuntimeOperationId, string> = {
  'team.packageValidate': 'matchaclaw.team.package.validate',
  'team.dependencyPlan': 'matchaclaw.team.dependency.plan',
  'team.runCreate': 'matchaclaw.team.run.create',
  'team.runStart': 'matchaclaw.team.run.start',
  'team.runSnapshot': 'matchaclaw.team.run.snapshot',
  'team.runDiagnostics': 'matchaclaw.team.run.diagnostics',
  'team.runDecisionSubmit': 'matchaclaw.team.run.decision.submit',
  'team.planWorkflow': 'matchaclaw.team.workflow.plan',
  'team.runTick': 'matchaclaw.team.run.tick',
  'team.approvalResolve': 'matchaclaw.team.approval.resolve',
  'team.runCancel': 'matchaclaw.team.run.cancel',
  'team.runDelete': 'matchaclaw.team.run.delete',
};

export const TEAM_RUNTIME_GATEWAY_PLUGIN: GatewayPluginCapabilityDefinition = {
  pluginId: 'team-runtime',
  methods: [
    'matchaclaw.team.package.validate',
    'matchaclaw.team.dependency.plan',
    'matchaclaw.team.run.create',
    'matchaclaw.team.run.start',
    'matchaclaw.team.run.snapshot',
    'matchaclaw.team.run.diagnostics',
    'matchaclaw.team.run.decision.submit',
    'matchaclaw.team.workflow.plan',
    'matchaclaw.team.run.tick',
    'matchaclaw.team.approval.resolve',
    'matchaclaw.team.run.cancel',
    'matchaclaw.team.run.delete',
  ],
};

export interface TeamSkillGatewayWorkflowDeps {
  readonly gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
  readonly capabilities: GatewayPluginCapabilityPort;
}

export class TeamSkillGatewayWorkflow {
  constructor(private readonly deps: TeamSkillGatewayWorkflowDeps) {}

  async invoke(operationId: TeamRuntimeOperationId, params: unknown): Promise<ApplicationResponseOf> {
    const method = TEAM_RUNTIME_OPERATION_METHODS[operationId];
    if (!method) {
      return badRequest(`Team runtime operation not supported: ${operationId}`);
    }
    const unavailable = await this.deps.capabilities.requirePluginMethod(
      TEAM_RUNTIME_GATEWAY_PLUGIN,
      method,
      TEAM_RUNTIME_CAPABILITY_TIMEOUT_MS,
    );
    if (unavailable) {
      return unavailable;
    }
    if (!this.isRecord(params)) {
      return badRequest('Team runtime params must be an object');
    }
    return ok(await this.deps.gateway.gatewayRpc(method, params, TEAM_RUNTIME_RPC_TIMEOUT_MS));
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }
}
