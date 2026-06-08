import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { createTeamRunRuntimeServices } from '../application/team-run-service-factory.js'
import { parseTeamGatewayParams, type TeamGatewayMethod } from './schemas.js'

type GatewayParams = Record<string, unknown>

type GatewayOptions = {
  params: unknown
  respond: (success: boolean, data?: unknown, error?: { code: string; message: string }) => void
}

export function registerTeamGatewayMethods(api: OpenClawPluginApi): void {
  const { packageService, runService } = createTeamRunRuntimeServices(api)

  registerGateway(api, 'matchaclaw.team.package.validate', async (params) => {
    return await packageService.validate(params.packagePath as string)
  })

  registerGateway(api, 'matchaclaw.team.run.create', async (params) => {
    return await runService.create({
      packagePath: params.packagePath as string,
      runId: params.runId as string | undefined,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.start', async (params) => {
    return await runService.start({
      runId: params.runId as string,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.snapshot', async (params) => {
    return await runService.snapshot({
      runId: params.runId as string,
      eventCursor: params.eventCursor as number | undefined,
      eventLimit: params.eventLimit as number | undefined,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.diagnostics', async (params) => {
    return await runService.diagnostics({
      runId: params.runId as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.decision.submit', async (params) => {
    return await runService.submitDecision({
      runId: params.runId as string,
      decision: params.decision as 'retry' | 'proceed_degraded' | 'abort',
      note: params.note as string | undefined,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.stage.complete', async (params) => {
    return await runService.completeStage({
      runId: params.runId as string,
      stageId: params.stageId as string,
      outputArtifactIds: params.outputArtifactIds as string[] | undefined,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.tick', async (params) => {
    return await runService.tick({
      runId: params.runId as string,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.dispatch.prepare', async (params) => {
    return await runService.prepareDispatch({
      runId: params.runId as string,
      stageId: params.stageId as string,
      roleId: params.roleId as string | undefined,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.dispatch.execute', async (params) => {
    return await runService.executeDispatch({
      runId: params.runId as string,
      dispatchId: params.dispatchId as string,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.approval.resolve', async (params) => {
    return await runService.resolveApproval({
      runId: params.runId as string,
      approvalId: params.approvalId as string,
      decision: params.decision as 'approve' | 'deny' | 'abort',
      note: params.note as string | undefined,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.run.cancel', async (params) => {
    return await runService.cancel({
      runId: params.runId as string,
      reason: params.reason as string | undefined,
      idempotencyKey: params.idempotencyKey as string,
    })
  })

  registerGateway(api, 'matchaclaw.team.gate.evaluate', async (params) => {
    return await runService.evaluateGate({
      runId: params.runId as string,
      artifactId: params.artifactId as string,
      gateType: params.gateType as string,
      idempotencyKey: params.idempotencyKey as string,
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
