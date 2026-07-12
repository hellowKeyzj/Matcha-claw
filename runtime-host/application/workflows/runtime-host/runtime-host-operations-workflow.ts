import { accepted, badRequest, ok, type ApplicationResponse } from '../../common/application-response';
import type { RuntimeHostBootstrapService } from '../../runtime-host/bootstrap';
import type { RuntimeJobsService } from '../../runtime-host/runtime-jobs-service';
import type { DiagnosticsCollectionWorkflow } from '../diagnostics/diagnostics-collection-workflow';

export interface RuntimeHostOperationsWorkflowDeps {
  readonly bootstrap: Pick<
    RuntimeHostBootstrapService,
    | 'submitGatewayPrelaunch'
    | 'buildProviderEnvMap'
    | 'getHostBootstrapSettings'
    | 'buildGatewayLaunchPlan'
    | 'onGatewayLifecycle'
  >;
  readonly diagnosticsCollectionWorkflow: Pick<DiagnosticsCollectionWorkflow, 'execute'>;
  readonly jobs: Pick<RuntimeJobsService, 'list' | 'get'>;
}

export class RuntimeHostOperationsWorkflow {
  constructor(private readonly deps: RuntimeHostOperationsWorkflowDeps) {}

  prepareGatewayLaunch(payload: unknown): ApplicationResponse {
    const body = isRecord(payload) ? payload : {};
    return accepted(this.deps.bootstrap.submitGatewayPrelaunch({
      ...(typeof body.gatewayToken === 'string' ? { gatewayToken: body.gatewayToken } : {}),
      ...(typeof body.proxyEnabled === 'boolean' ? { proxyEnabled: body.proxyEnabled } : {}),
      ...(typeof body.proxyServer === 'string' ? { proxyServer: body.proxyServer } : {}),
      ...(typeof body.proxyBypassRules === 'string' ? { proxyBypassRules: body.proxyBypassRules } : {}),
    }));
  }

  providerEnvMap() {
    return {
      success: true,
      ...this.deps.bootstrap.buildProviderEnvMap(),
    };
  }

  async hostBootstrapSettings(): Promise<ApplicationResponse> {
    return ok({
      success: true,
      settings: await this.deps.bootstrap.getHostBootstrapSettings(),
    });
  }

  async gatewayLaunchPlan(): Promise<ApplicationResponse> {
    return ok({
      success: true,
      plan: await this.deps.bootstrap.buildGatewayLaunchPlan(),
    });
  }

  gatewayLifecycle(payload: unknown): ApplicationResponse {
    return ok({
      success: true,
      job: this.deps.bootstrap.onGatewayLifecycle(payload),
    });
  }

  async collectDiagnostics(payload: unknown): Promise<ApplicationResponse> {
    return await this.deps.diagnosticsCollectionWorkflow.execute(payload);
  }

  runtimeJobs(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return this.deps.jobs.list(typeof body.type === 'string' ? body.type : undefined);
  }

  runtimeJob(payload: unknown): ApplicationResponse {
    const body = isRecord(payload) ? payload : {};
    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
    if (!jobId) {
      return badRequest('jobId is required');
    }
    return ok(this.deps.jobs.get(jobId));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
