import { triggerCronJobWithSplitProfiles } from './manual-trigger';
import { accepted, badRequest, type ApplicationResponse } from '../common/application-response';
import type { RuntimeClockPort, RuntimeTimerPort } from '../common/runtime-ports';
import type { GatewayCronPort } from '../gateway/gateway-runtime-port';
import { isGatewayReadyForSnapshot, isGatewayStartupConnectionError } from '../gateway/gateway-readiness';
import type { CronRuntimeJobPort } from './cron-jobs';
import type { TokenUsageHistoryRepository } from '../usage/token-usage-history';
import {
  asCronCreateInput,
  getCronDeliveryValidationError,
  isRecord,
  mergeCronDelivery,
  normalizeCronAgentId,
  normalizeCronDelivery,
  normalizeCronDeliveryPatch,
  normalizeCronJob,
  parseGatewayCronJobs,
  type GatewayCronDelivery,
} from './cron-model';
import { CronSessionHistoryService } from './cron-session-history';

type CronUpdatePatchResult =
  | { readonly ok: true; readonly patch: Record<string, any> }
  | { readonly ok: false; readonly response: ApplicationResponse };

function extractErrorMessage(response: ApplicationResponse, fallback: string): string {
  const data = isRecord(response.data) ? response.data : null;
  return typeof data?.error === 'string' && data.error ? data.error : fallback;
}

export interface CronServiceDeps {
  readonly gateway: GatewayCronPort;
  readonly sessionHistory: Pick<CronSessionHistoryService, 'read'>;
  readonly usageHistory: TokenUsageHistoryRepository;
  readonly timer: RuntimeTimerPort;
  readonly clock: RuntimeClockPort;
  readonly jobs: CronRuntimeJobPort;
  readonly requestUsageHistoryRefresh?: () => void;
}

export class CronService {
  private jobsSnapshot: unknown[] = [];
  private jobsSnapshotReady = false;
  private jobsSnapshotError: string | null = null;
  private jobsSnapshotUpdatedAt: number | null = null;

  constructor(private readonly deps: CronServiceDeps) {}

  async usageRecent(payload: unknown, routeUrl: URL) {
    let limit: number | undefined;
    const queryLimitRaw = routeUrl.searchParams.get('limit');
    if (typeof queryLimitRaw === 'string' && queryLimitRaw.trim()) {
      const queryLimit = Number(queryLimitRaw);
      if (Number.isFinite(queryLimit)) {
        limit = Math.max(Math.floor(queryLimit), 0);
      }
    }
    if (limit === undefined && isRecord(payload)) {
      const payloadLimit = Number(payload.limit);
      if (Number.isFinite(payloadLimit)) {
        limit = Math.max(Math.floor(payloadLimit), 0);
      }
    }
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
    return {
      success: true,
      ready: this.jobsSnapshotReady,
      refreshing: refreshSubmitted,
      updatedAt: this.jobsSnapshotUpdatedAt,
      error: this.jobsSnapshotError,
      jobs: this.jobsSnapshot,
    };
  }

  async refreshJobsSnapshot() {
    if (!(await isGatewayReadyForSnapshot(this.deps.gateway))) {
      return {
        success: true,
        ready: this.jobsSnapshotReady,
        refreshing: false,
        updatedAt: this.jobsSnapshotUpdatedAt,
        error: this.jobsSnapshotError,
        jobs: this.jobsSnapshot,
      };
    }
    try {
      const listResult = await this.deps.gateway.listCronJobs(true);
      const jobs = parseGatewayCronJobs(listResult);
      if (jobs.some((job) => this.needsDeliveryRepair(job))) {
        this.deps.jobs.submitRepairDelivery();
      }
      this.jobsSnapshot = jobs.map((job) => normalizeCronJob(this.toReadModel(job), this.deps.clock));
      this.jobsSnapshotReady = true;
      this.jobsSnapshotError = null;
      this.jobsSnapshotUpdatedAt = this.deps.clock.nowMs();
      return {
        success: true,
        jobs: this.jobsSnapshot,
        updatedAt: this.jobsSnapshotUpdatedAt,
      };
    } catch (error) {
      if (isGatewayStartupConnectionError(error)) {
        return {
          success: true,
          ready: this.jobsSnapshotReady,
          refreshing: false,
          updatedAt: this.jobsSnapshotUpdatedAt,
          error: this.jobsSnapshotError,
          jobs: this.jobsSnapshot,
        };
      }
      this.jobsSnapshotError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async executeDeliveryRepair() {
    const listResult = await this.deps.gateway.listCronJobs(true);
    const jobs = parseGatewayCronJobs(listResult);
    let repairedCount = 0;
    for (const job of jobs) {
      if (!this.needsDeliveryRepair(job)) {
        continue;
      }
      await this.deps.gateway.updateCronJob(job.id, { delivery: { mode: 'none' } });
      repairedCount += 1;
    }
    return {
      success: true,
      repairedCount,
    };
  }

  private needsDeliveryRepair(job: Record<string, any>): boolean {
    const payload = isRecord(job.payload) ? job.payload : {};
    const delivery = isRecord(job.delivery) ? job.delivery : {};
    return (job.sessionTarget === 'isolated' || !job.sessionTarget)
      && payload.kind === 'agentTurn'
      && delivery.mode === 'announce'
      && !delivery.channel;
  }

  private toReadModel(job: Record<string, any>): Record<string, any> {
    if (!this.needsDeliveryRepair(job)) {
      return job;
    }
    const state = isRecord(job.state) ? job.state : {};
    return {
      ...job,
      delivery: { mode: 'none' },
      state: typeof state.lastError === 'string' && state.lastError.includes('Channel is required')
        ? {
            ...state,
            lastError: undefined,
            lastStatus: 'ok',
          }
        : state,
      }
    ;
  }

  async sessionHistory(routeUrl: URL) {
    return await this.deps.sessionHistory.read(routeUrl);
  }

  async createJob(payload: unknown) {
    const input = asCronCreateInput(payload);
    if (!input) {
      return badRequest('Invalid cron create payload');
    }
    const deliveryValidationError = getCronDeliveryValidationError(input.delivery);
    if (deliveryValidationError) {
      return badRequest(deliveryValidationError);
    }
    return accepted(this.deps.jobs.submitCreate(payload));
  }

  async executeCreateJob(payload: unknown) {
    const input = asCronCreateInput(payload);
    if (!input) {
      throw new Error('Invalid cron create payload');
    }
    const deliveryValidationError = getCronDeliveryValidationError(input.delivery);
    if (deliveryValidationError) {
      throw new Error(deliveryValidationError);
    }
    const created = await this.deps.gateway.addCronJob({
      name: input.name,
      agentId: input.agentId,
      schedule: { kind: 'cron', expr: input.schedule },
      payload: { kind: 'agentTurn', message: input.message },
      enabled: input.enabled ?? true,
      wakeMode: 'next-heartbeat',
      sessionTarget: 'isolated',
      delivery: input.delivery,
    });
    const result = isRecord(created) ? normalizeCronJob(created, this.deps.clock) : created;
    await this.refreshJobsSnapshot();
    return result;
  }

  async updateJob(jobId: string, payload: unknown) {
    const patchResult = await this.buildUpdatePatch(jobId, payload);
    if (!patchResult.ok) {
      return patchResult.response;
    }
    return accepted(this.deps.jobs.submitUpdate({ jobId, updates: payload }));
  }

  async executeUpdateJob(jobId: string, payload: unknown) {
    const patchResult = await this.buildUpdatePatch(jobId, payload);
    if (!patchResult.ok) {
      throw new Error(extractErrorMessage(patchResult.response, 'Invalid cron update payload'));
    }
    const result = await this.deps.gateway.updateCronJob(jobId, patchResult.patch);
    await this.refreshJobsSnapshot();
    return result;
  }

  async deleteJob(jobId: string) {
    return accepted(this.deps.jobs.submitDelete({ jobId }));
  }

  async executeDeleteJob(jobId: string) {
    const result = await this.deps.gateway.removeCronJob(jobId);
    await this.refreshJobsSnapshot();
    return result;
  }

  toggleJob(payload: unknown) {
    const body = isRecord(payload) ? payload : null;
    if (!body || typeof body.id !== 'string' || typeof body.enabled !== 'boolean') {
      return badRequest('Invalid cron toggle payload');
    }
    return accepted(this.deps.jobs.submitToggle({ id: body.id, enabled: body.enabled }));
  }

  async executeToggleJob(payload: unknown) {
    const body = isRecord(payload) ? payload : null;
    if (!body || typeof body.id !== 'string' || typeof body.enabled !== 'boolean') {
      throw new Error('Invalid cron toggle payload');
    }
    const result = await this.deps.gateway.updateCronJob(body.id, { enabled: body.enabled });
    await this.refreshJobsSnapshot();
    return result;
  }

  trigger(payload: unknown) {
    const body = isRecord(payload) ? payload : null;
    if (!body || typeof body.id !== 'string') {
      return badRequest('Invalid cron trigger payload');
    }
    return accepted(this.deps.jobs.submitTrigger({ id: body.id }));
  }

  async executeTrigger(payload: unknown) {
    const body = isRecord(payload) ? payload : null;
    if (!body || typeof body.id !== 'string') {
      throw new Error('Invalid cron trigger payload');
    }
    const result = await triggerCronJobWithSplitProfiles({
      gateway: this.deps.gateway,
      id: body.id,
      clock: this.deps.clock,
      timer: this.deps.timer,
    });
    await this.refreshJobsSnapshot();
    return result;
  }

  private async buildUpdatePatch(jobId: string, payload: unknown): Promise<CronUpdatePatchResult> {
    const input = isRecord(payload) ? payload : null;
    if (!input) {
      return {
        ok: false,
        response: badRequest('Invalid cron update payload'),
      };
    }
    const patch: Record<string, any> = { ...input };
    if (typeof patch.schedule === 'string') {
      patch.schedule = { kind: 'cron', expr: patch.schedule };
    }
    if (typeof patch.message === 'string') {
      patch.payload = { kind: 'agentTurn', message: patch.message };
      delete patch.message;
    }
    if ('agentId' in patch) {
      patch.agentId = normalizeCronAgentId(patch.agentId);
    }
    if ('delivery' in patch) {
      patch.delivery = normalizeCronDeliveryPatch(patch.delivery);
      const deliveryPatch = isRecord(patch.delivery) ? patch.delivery : {};
      const currentDelivery = this.getJobDelivery(jobId);
      const mergedDelivery = mergeCronDelivery(currentDelivery, deliveryPatch);
      const deliveryValidationError = getCronDeliveryValidationError(mergedDelivery);
      if (deliveryValidationError) {
        return {
          ok: false,
          response: badRequest(deliveryValidationError),
        };
      }
    }
    return {
      ok: true,
      patch,
    };
  }

  private getJobDelivery(jobId: string): GatewayCronDelivery {
    const matchedJobRaw = this.jobsSnapshot.find((job) => isRecord(job) && job.id === jobId);
    const matchedJob = isRecord(matchedJobRaw) ? matchedJobRaw : null;
    if (!matchedJob || !isRecord(matchedJob.delivery)) {
      return { mode: 'none' };
    }
    return normalizeCronDelivery(matchedJob.delivery);
  }

}
