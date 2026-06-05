import { accepted, badRequest } from '../../common/application-response';
import type { GatewayCronPort } from '../../gateway/gateway-runtime-port';
import { isGatewayReadyForSnapshot } from '../../gateway/gateway-readiness';
import type { CronRuntimeJobPort } from '../../cron/cron-jobs';
import {
  DEFAULT_CRON_DELIVERY_CHANNEL_PROJECTION,
  asCronCreateInput,
  getCronDeliveryValidationError,
  isRecord,
  type CronDeliveryChannelProjectionPort,
} from '../../cron/cron-model';
import type { TokenUsageHistoryRepository } from '../../usage/token-usage-history';
import type { CronJobMutationWorkflow } from './cron-job-mutation-workflow';

export interface CronOperationsWorkflowDeps {
  readonly gateway: GatewayCronPort;
  readonly usageHistory: TokenUsageHistoryRepository;
  readonly jobs: CronRuntimeJobPort;
  readonly jobMutationWorkflow: Pick<
    CronJobMutationWorkflow,
    | 'getSnapshotState'
    | 'refreshJobsSnapshot'
    | 'executeDeliveryRepair'
    | 'executeCreateJob'
    | 'executeUpdateJob'
    | 'executeDeleteJob'
    | 'executeToggleJob'
    | 'executeTrigger'
    | 'buildUpdatePatch'
  >;
  readonly deliveryChannelProjection?: CronDeliveryChannelProjectionPort;
  readonly requestUsageHistoryRefresh?: () => void;
}

export class CronOperationsWorkflow {
  constructor(private readonly deps: CronOperationsWorkflowDeps) {}

  private get deliveryChannelProjection(): CronDeliveryChannelProjectionPort {
    return this.deps.deliveryChannelProjection ?? DEFAULT_CRON_DELIVERY_CHANNEL_PROJECTION;
  }

  async usageRecent(payload: unknown, routeUrl: URL) {
    const limit = this.readUsageRecentLimit(payload, routeUrl);
    if (!this.deps.usageHistory.isReady()) {
      await this.deps.usageHistory.refreshCache({ limit });
    }
    this.deps.requestUsageHistoryRefresh?.();
    return this.deps.usageHistory.recent({ limit });
  }

  async listJobs() {
    let refreshSubmitted = false;
    if (await isGatewayReadyForSnapshot(this.deps.gateway)) {
      this.deps.jobs.submitRefreshJobs();
      refreshSubmitted = true;
    }
    const snapshot = this.deps.jobMutationWorkflow.getSnapshotState();
    return {
      success: true,
      ready: snapshot.jobsSnapshotReady,
      refreshing: refreshSubmitted,
      updatedAt: snapshot.jobsSnapshotUpdatedAt,
      error: snapshot.jobsSnapshotError,
      jobs: snapshot.jobsSnapshot,
    };
  }

  async refreshJobsSnapshot() {
    return await this.deps.jobMutationWorkflow.refreshJobsSnapshot();
  }

  async executeDeliveryRepair() {
    return await this.deps.jobMutationWorkflow.executeDeliveryRepair();
  }

  async createJob(payload: unknown) {
    const input = asCronCreateInput(payload, this.deliveryChannelProjection);
    if (!input) {
      return badRequest('Invalid cron create payload');
    }
    const deliveryValidationError = getCronDeliveryValidationError(input.delivery, this.deliveryChannelProjection);
    if (deliveryValidationError) {
      return badRequest(deliveryValidationError);
    }
    return accepted(this.deps.jobs.submitCreate(payload));
  }

  async executeCreateJob(payload: unknown) {
    return await this.deps.jobMutationWorkflow.executeCreateJob(payload);
  }

  async updateJob(jobId: string, payload: unknown) {
    const patchResult = this.deps.jobMutationWorkflow.buildUpdatePatch(jobId, payload);
    if (!patchResult.ok) {
      return badRequest(patchResult.error);
    }
    return accepted(this.deps.jobs.submitUpdate({ jobId, updates: payload }));
  }

  async executeUpdateJob(jobId: string, payload: unknown) {
    return await this.deps.jobMutationWorkflow.executeUpdateJob(jobId, payload);
  }

  async deleteJob(jobId: string) {
    return accepted(this.deps.jobs.submitDelete({ jobId }));
  }

  async executeDeleteJob(jobId: string) {
    return await this.deps.jobMutationWorkflow.executeDeleteJob(jobId);
  }

  toggleJob(payload: unknown) {
    const body = isRecord(payload) ? payload : null;
    if (!body || typeof body.id !== 'string' || typeof body.enabled !== 'boolean') {
      return badRequest('Invalid cron toggle payload');
    }
    return accepted(this.deps.jobs.submitToggle({ id: body.id, enabled: body.enabled }));
  }

  async executeToggleJob(payload: unknown) {
    return await this.deps.jobMutationWorkflow.executeToggleJob(payload);
  }

  trigger(payload: unknown) {
    const body = isRecord(payload) ? payload : null;
    if (!body || typeof body.id !== 'string') {
      return badRequest('Invalid cron trigger payload');
    }
    return accepted(this.deps.jobs.submitTrigger({ id: body.id }));
  }

  async executeTrigger(payload: unknown) {
    return await this.deps.jobMutationWorkflow.executeTrigger(payload);
  }

  private readUsageRecentLimit(payload: unknown, routeUrl: URL): number | undefined {
    const queryLimit = this.normalizeLimit(routeUrl.searchParams.get('limit'));
    if (queryLimit !== undefined) {
      return queryLimit;
    }
    return isRecord(payload) ? this.normalizeLimit(payload.limit) : undefined;
  }

  private normalizeLimit(value: unknown): number | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return undefined;
    }
    const limit = Number(value);
    if (!Number.isFinite(limit)) {
      return undefined;
    }
    return Math.max(Math.floor(limit), 0);
  }
}
