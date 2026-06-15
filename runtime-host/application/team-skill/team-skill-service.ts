import { serverError } from '../common/application-response';
import type { RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import type { RuntimePluginConfigProjectionPort, RuntimePluginConfigStorePort } from '../plugins/runtime-plugin-service';
import type { TeamRuntimeOperationId, TeamSkillGatewayWorkflow } from '../workflows/team-skill/team-skill-gateway-workflow';
import type { TeamRunTaskProjectionWorkflow } from '../workflows/team-skill/team-run-task-projection-workflow';
import type { TeamManagedAgentConfigWorkflow } from './team-managed-agent-config-workflow';

const TEAM_RUNTIME_PLUGIN_ID = 'team-runtime';
const TEAM_GATEWAY_CONFIG_RELOAD_WAIT_MS = 500;

export interface TeamRuntimePluginConfigDeps {
  readonly pluginConfigStore: RuntimePluginConfigStorePort;
  readonly pluginConfigProjection: Pick<RuntimePluginConfigProjectionPort, 'readManuallyManagedPluginIds' | 'applyManuallyManagedPluginIds'>;
}

export class TeamSkillService {
  constructor(
    private readonly gatewayWorkflow: TeamSkillGatewayWorkflow,
    private readonly taskProjectionWorkflow?: TeamRunTaskProjectionWorkflow,
    private readonly managedAgentConfigWorkflow?: TeamManagedAgentConfigWorkflow,
    private readonly runtimePluginConfig?: TeamRuntimePluginConfigDeps,
  ) {}

  async invoke(operationId: TeamRuntimeOperationId, params: unknown, scope?: RuntimeScope) {
    if (operationId === 'team.runCreate' || operationId === 'team.runStart') {
      try {
        await this.ensureTeamRuntimePluginEnabled();
      } catch (error) {
        return serverError(error instanceof Error ? error.message : String(error));
      }
    }

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
          await this.ensureGatewayConfigReloaded();
        }
      } catch (error) {
        return serverError(error instanceof Error ? error.message : String(error));
      }
    }

    if (operationId === 'team.runDelete') {
      try {
        if (!this.managedAgentConfigWorkflow) {
          throw new Error('Team managed agent config workflow is not configured');
        }
        const managedAgentConfig = this.managedAgentConfigWorkflow.readManagedAgentConfig(this.readRecord(response.data).managedAgentConfig);
        if (managedAgentConfig) {
          await this.managedAgentConfigWorkflow.removeRun(managedAgentConfig);
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

  private async ensureGatewayConfigReloaded(): Promise<void> {
    // Gateway config reloader uses chokidar file watcher with 300ms debounce.
    // Wait for the debounce to complete so the Gateway picks up the new agents.list
    // before the frontend calls team.runStart to launch the leader agent session.
    await new Promise<void>((resolve) => setTimeout(resolve, TEAM_GATEWAY_CONFIG_RELOAD_WAIT_MS));
  }

  private async ensureTeamRuntimePluginEnabled(): Promise<void> {
    if (!this.runtimePluginConfig) {
      return;
    }
    await this.runtimePluginConfig.pluginConfigStore.updateDirty(async (config) => {
      const manualPluginIds = await this.runtimePluginConfig!.pluginConfigProjection.readManuallyManagedPluginIds(config);
      if (manualPluginIds.includes(TEAM_RUNTIME_PLUGIN_ID)) {
        return { result: undefined, changed: false };
      }
      const nextConfig = await this.runtimePluginConfig!.pluginConfigProjection.applyManuallyManagedPluginIds(config, [...manualPluginIds, TEAM_RUNTIME_PLUGIN_ID]);
      for (const key of Object.keys(config)) {
        delete config[key];
      }
      Object.assign(config, nextConfig);
      return { result: undefined, changed: true };
    });
  }

  private readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}
