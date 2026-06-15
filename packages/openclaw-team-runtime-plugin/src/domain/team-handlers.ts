import type { TeamEvent, TeamEventHandler } from './team-event-bus.js'
import {
  TEAM_DISPATCH_PROCESS_GATEWAY_METHOD,
  TEAM_LEADER_SYNTHESIS_PROCESS_GATEWAY_METHOD,
  type TeamBackgroundGatewayMethod,
} from '../gateway/schemas.js'

export interface DispatchHandlerDeps {
  requestTeamGateway(method: TeamBackgroundGatewayMethod, params: { runId: string }): Promise<void>
  hasPending(runId: string): Promise<boolean>
}

export class DispatchHandler implements TeamEventHandler {
  constructor(private readonly deps: DispatchHandlerDeps) {}

  async handle(event: TeamEvent): Promise<void> {
    if (!event.runId) {
      return
    }
    await this.deps.requestTeamGateway(TEAM_DISPATCH_PROCESS_GATEWAY_METHOD, { runId: event.runId })
  }
}

export class LeaderSynthesisHandler implements TeamEventHandler {
  constructor(private readonly deps: DispatchHandlerDeps) {}

  async handle(event: TeamEvent): Promise<void> {
    if (!event.runId) {
      return
    }
    if (await this.deps.hasPending(event.runId)) {
      return
    }
    await this.deps.requestTeamGateway(TEAM_LEADER_SYNTHESIS_PROCESS_GATEWAY_METHOD, { runId: event.runId })
  }
}
