import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { createTeamRunPluginRuntimeRegistry } from '../application/team-run-service-factory.js'
import {
  parseTeamGatewayParams,
  TEAM_DISPATCH_PROCESS_GATEWAY_METHOD,
  TEAM_LEADER_SYNTHESIS_PROCESS_GATEWAY_METHOD,
  type TeamBackgroundGatewayMethod,
  type TeamGatewayMethod,
} from './schemas.js'

type GatewayParams = Record<string, unknown>

type GatewayOptions = {
  params: unknown
  respond: (success: boolean, data?: unknown, error?: { code: string; message: string }) => void
}

export interface TeamGatewayRequestPort {
  request(method: TeamBackgroundGatewayMethod, params: { runId: string }): Promise<void>
}

export function createTeamGatewayRequestPort(api: OpenClawPluginApi): TeamGatewayRequestPort {
  const runtimeGateway = readRuntimeGateway(api)
  if (!runtimeGateway) {
    throw new Error('Team runtime requires api.runtime.gateway.request to consume background Team events inside the runtime gateway channel.')
  }
  return {
    async request(method, params) {
      await runtimeGateway.request({ method, params, waitForFinal: true })
    },
  }
}

export function registerTeamGatewayMethods(api: OpenClawPluginApi): void {
  const runtimeRegistry = createTeamRunPluginRuntimeRegistry(api)

  registerGateway(api, 'matchaclaw.team.package.validate', async (params) => {
    return await runtimeRegistry.packageService.validate(params.packagePath as string)
  })

  registerGateway(api, 'matchaclaw.team.dependency.plan', async (params) => {
    return await runtimeRegistry.planDependencies({
      packagePath: params.packagePath as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.create', async (params) => {
    return await runtimeRegistry.createRun({
      packagePath: params.packagePath as string,
      runId: params.runId as string | undefined,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.start', async (params) => {
    return await runtimeRegistry.serviceForRun(params.runId as string).start({
      runId: params.runId as string,
      idempotencyKey: params.idempotencyKey as string,
      initialPrompt: params.initialPrompt as string | undefined,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.snapshot', async (params) => {
    return await runtimeRegistry.serviceForRun(params.runId as string).snapshot({
      runId: params.runId as string,
      eventCursor: params.eventCursor as number | undefined,
      eventLimit: params.eventLimit as number | undefined,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.diagnostics', async (params) => {
    return await runtimeRegistry.serviceForRun(params.runId as string).diagnostics({
      runId: params.runId as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.decision.submit', async (params) => {
    return await runtimeRegistry.serviceForRun(params.runId as string).submitDecision({
      runId: params.runId as string,
      decision: params.decision as 'retry' | 'proceed_degraded' | 'abort',
      note: params.note as string | undefined,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.workflow.plan', async (params) => {
    return await runtimeRegistry.serviceForRun(params.runId as string).planWorkflow({
      runId: params.runId as string,
      title: params.title as string,
      summary: params.summary as string | undefined,
      groups: params.groups as Record<string, unknown>[],
      tasks: params.tasks as Record<string, unknown>[],
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.tick', async (params) => {
    return await runtimeRegistry.serviceForRun(params.runId as string).tick({
      runId: params.runId as string,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, TEAM_DISPATCH_PROCESS_GATEWAY_METHOD, async (params) => {
    await runtimeRegistry.serviceForRun(params.runId as string).processDispatchQueue({
      runId: params.runId as string,
    })
    return { runId: params.runId as string }
  })

  registerGateway(api, TEAM_LEADER_SYNTHESIS_PROCESS_GATEWAY_METHOD, async (params) => {
    await runtimeRegistry.serviceForRun(params.runId as string).processLeaderSynthesis({
      runId: params.runId as string,
    })
    return { runId: params.runId as string }
  })

  registerGateway(api, 'matchaclaw.team.approval.resolve', async (params) => {
    return await runtimeRegistry.serviceForRun(params.runId as string).resolveApproval({
      runId: params.runId as string,
      approvalId: params.approvalId as string,
      decision: params.decision as 'approve' | 'deny' | 'abort',
      note: params.note as string | undefined,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.cancel', async (params) => {
    return await runtimeRegistry.serviceForRun(params.runId as string).cancel({
      runId: params.runId as string,
      reason: params.reason as string | undefined,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.delete', async (params) => {
    return await runtimeRegistry.deleteRun({
      runId: params.runId as string,
    })
  })
}

function registerGateway(
  api: OpenClawPluginApi,
  name: TeamGatewayMethod,
  handler: (params: GatewayParams) => Promise<unknown>,
): void {
  api.registerGatewayMethod(name, async (options: GatewayOptions) => {
    try {
      options.respond(true, await handler(parseTeamGatewayParams(name, options.params)))
    } catch (error) {
      options.respond(false, undefined, {
        code: 'invalid_request',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

function readRuntimeGateway(api: OpenClawPluginApi): {
  request(params: { method: string; params?: Record<string, unknown>; waitForFinal?: boolean; timeoutMs?: number }): Promise<unknown>
} | null {
  const runtime = api.runtime as unknown
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    return null
  }
  const gateway = (runtime as { gateway?: unknown }).gateway
  if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway)) {
    return null
  }
  const request = (gateway as { request?: unknown }).request
  return typeof request === 'function'
    ? gateway as { request(params: { method: string; params?: Record<string, unknown>; waitForFinal?: boolean; timeoutMs?: number }): Promise<unknown> }
    : null
}
