import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { createTeamRunPluginRuntimeRegistry, TEAM_LEADER_SYNTHESIS_RUN_CONTEXT_NAMESPACE } from './application/team-run-service-factory.js'
import { registerTeamGatewayMethods } from './gateway/team-gateway-methods.js'
import { registerTeamArtifactTools } from './tools/team-artifact-tools.js'
import {
  TEAM_RUNTIME_PLUGIN_DESCRIPTION,
  TEAM_RUNTIME_PLUGIN_ID,
  TEAM_RUNTIME_PLUGIN_NAME,
} from './manifest.js'

function isLeaderSynthesisTerminalLifecycleEvent(event: { stream: string; data: Record<string, unknown> }): boolean {
  if (event.stream !== 'lifecycle') {
    return false
  }
  const phase = event.data.phase
  return phase === 'final' || phase === 'error' || phase === 'aborted'
}

export default definePluginEntry({
  id: TEAM_RUNTIME_PLUGIN_ID,
  name: TEAM_RUNTIME_PLUGIN_NAME,
  description: TEAM_RUNTIME_PLUGIN_DESCRIPTION,
  register(api: OpenClawPluginApi) {
    const runtimeRegistry = createTeamRunPluginRuntimeRegistry(api)
    api.agent.events.registerAgentEventSubscription({
      id: 'team-runtime-leader-synthesis-terminalization',
      description: 'Complete TeamRun when leader synthesis reaches a lifecycle terminal state.',
      streams: ['lifecycle'],
      async handle(event, ctx) {
        if (!isLeaderSynthesisTerminalLifecycleEvent(event)) {
          return
        }
        const tracked = ctx.getRunContext<{ teamRunId?: string; workflowPlanId?: string }>(TEAM_LEADER_SYNTHESIS_RUN_CONTEXT_NAMESPACE)
        if (!tracked?.teamRunId || !tracked.workflowPlanId) {
          if (tracked?.teamRunId) {
            await runtimeRegistry.serviceForRun(tracked.teamRunId).recordLeaderSynthesisTerminalIgnored({
              teamRunId: tracked.teamRunId,
              workflowPlanId: tracked.workflowPlanId,
              reason: 'tracked_context_incomplete',
              ...(typeof event.data.message === 'string' && event.data.message.trim() ? { message: event.data.message.trim() } : {}),
            })
          }
          return
        }
        await runtimeRegistry.serviceForRun(tracked.teamRunId).completeLeaderSynthesis({
          teamRunId: tracked.teamRunId,
          workflowPlanId: tracked.workflowPlanId,
          succeeded: event.data.phase === 'final',
          ...(typeof event.data.message === 'string' && event.data.message.trim() ? { reason: event.data.message.trim() } : {}),
        })
        ctx.clearRunContext(TEAM_LEADER_SYNTHESIS_RUN_CONTEXT_NAMESPACE)
      },
    })
    registerTeamGatewayMethods(api)
    registerTeamArtifactTools(api)
  },
})
