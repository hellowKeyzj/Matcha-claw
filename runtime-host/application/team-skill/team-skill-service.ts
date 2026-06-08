import { serverError } from '../common/application-response';
import type { RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import type { TeamRuntimeOperationId, TeamSkillGatewayWorkflow } from '../workflows/team-skill/team-skill-gateway-workflow';
import type { TeamRunTaskProjectionWorkflow } from '../workflows/team-skill/team-run-task-projection-workflow';
import type { TeamManagedAgentConfigWorkflow } from './team-managed-agent-config-workflow';

export class TeamSkillService {
  constructor(
    private readonly gatewayWorkflow: TeamSkillGatewayWorkflow,
    private readonly taskProjectionWorkflow?: TeamRunTaskProjectionWorkflow,
    private readonly managedAgentConfigWorkflow?: TeamManagedAgentConfigWorkflow,
  ) {}

  async invoke(operationId: TeamRuntimeOperationId, params: unknown, scope?: RuntimeScope) {
    const response = await this.gatewayWorkflow.invoke(operationId, params);
    if (response.status >= 400) {
      return response;
    }

    let responseData = response.data;
    if (operationId === 'team.runCreate') {
      try {
        const responseRecord = this.readRecord(response.data);
        if (Object.prototype.hasOwnProperty.call(responseRecord, 'managedAgentConfig')) {
          if (!this.managedAgentConfigWorkflow) {
            throw new Error('Team managed agent config workflow is not configured');
          }
          const managedAgentConfig = this.managedAgentConfigWorkflow.readManagedAgentConfig(responseRecord.managedAgentConfig);
          if (!managedAgentConfig) {
            throw new Error('Team managed agent config projection is incomplete');
          }
          await this.managedAgentConfigWorkflow.apply(managedAgentConfig);
          responseData = this.managedAgentConfigWorkflow.stripManagedAgentConfig(response.data);
        }
      } catch (error) {
        return serverError(error instanceof Error ? error.message : String(error));
      }
    }

    if (scope) {
      try {
        await this.taskProjectionWorkflow?.projectAfterOperation({
          operationId,
          scope,
          params: this.readRecord(params),
          responseData,
        });
      } catch {
        // Task projection is best-effort; TeamRun state remains the source of truth.
      }
    }
    return { ...response, data: responseData };
  }

  private readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}
