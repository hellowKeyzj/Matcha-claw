import type { RuntimeClockPort } from '../../common/runtime-ports';
import type { GatewayCronPort } from '../../gateway/gateway-runtime-port';
import { isGatewayReadyForSnapshot, isGatewayStartupConnectionError } from '../../gateway/gateway-readiness';
import type { CronRuntimeJobPort } from '../../cron/cron-jobs';
import {
  DEFAULT_CRON_DELIVERY_CHANNEL_PROJECTION,
  asCronCreateInput,
  getCronDeliveryValidationError,
  isRecord,
  mergeCronDelivery,
  normalizeCronAgentId,
  normalizeCronDelivery,
  normalizeCronDeliveryPatch,
  normalizeCronJob,
  parseGatewayCronJobs,
  type CronDeliveryChannelProjectionPort,
  type GatewayCronDelivery,
} from '../../cron/cron-model';
import type { ScheduledAgentTriggerWorkflow } from '../scheduled-agent/scheduled-agent-trigger-workflow';

export interface CronSnapshotState {
  readonly jobsSnapshot: unknown[];
  readonly jobsSnapshotReady: boolean;
  readonly jobsSnapshotError: string | null;
  readonly jobsSnapshotUpdatedAt: number | null;
}

export interface CronSnapshotUpdate {
  readonly jobsSnapshot?: unknown[];
  readonly jobsSnapshotReady?: boolean;
  readonly jobsSnapshotError?: string | null;
  readonly jobsSnapshotUpdatedAt?: number | null;
}

export interface CronJobMutationWorkflowDeps {
  readonly gateway: GatewayCronPort;
  readonly clock: RuntimeClockPort;
  readonly jobs: Pick<CronRuntimeJobPort, 'submitRepairDelivery'>;
  readonly scheduledAgentTriggerWorkflow: Pick<ScheduledAgentTriggerWorkflow, 'execute'>;
  readonly deliveryChannelProjection?: CronDeliveryChannelProjectionPort;
}

type CronUpdatePatchResult =
  | { readonly ok: true; readonly patch: Record<string, any> }
  | { readonly ok: false; readonly error: string };

export class CronJobMutationWorkflow {
  private jobsSnapshot: unknown[] = [];
  private jobsSnapshotReady = false;
  private jobsSnapshotError: string | null = null;
  private jobsSnapshotUpdatedAt: number | null = null;

  constructor(private readonly deps: CronJobMutationWorkflowDeps) {}

  getSnapshotState(): CronSnapshotState {
    return {
      jobsSnapshot: this.jobsSnapshot,
      jobsSnapshotReady: this.jobsSnapshotReady,
      jobsSnapshotError: this.jobsSnapshotError,
      jobsSnapshotUpdatedAt: this.jobsSnapshotUpdatedAt,
    };
  }

  private get deliveryChannelProjection(): CronDeliveryChannelProjectionPort {
    return this.deps.deliveryChannelProjection ?? DEFAULT_CRON_DELIVERY_CHANNEL_PROJECTION;
  }

  async refreshJobsSnapshot() {
    const state = this.getSnapshotState();
    if (!(await isGatewayReadyForSnapshot(this.deps.gateway))) {
      return this.currentSnapshotResponse(state, false);
    }
    try {
      const listResult = await this.deps.gateway.listCronJobs(true);
      const jobs = parseGatewayCronJobs(listResult);
      if (jobs.some((job) => this.needsDeliveryRepair(job))) {
        this.deps.jobs.submitRepairDelivery();
      }
      const jobsSnapshot = jobs
        .map((job) => normalizeCronJob(this.toReadModel(job), this.deps.clock, this.deliveryChannelProjection))
        .filter((job): job is NonNullable<typeof job> => job !== null);
      const jobsSnapshotUpdatedAt = this.deps.clock.nowMs();
      this.jobsSnapshot = jobsSnapshot;
      this.jobsSnapshotReady = true;
      this.jobsSnapshotError = null;
      this.jobsSnapshotUpdatedAt = jobsSnapshotUpdatedAt;
      return {
        success: true,
        jobs: jobsSnapshot,
        updatedAt: jobsSnapshotUpdatedAt,
      };
    } catch (error) {
      if (isGatewayStartupConnectionError(error)) {
        return this.currentSnapshotResponse(this.getSnapshotState(), false);
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

  async executeCreateJob(payload: unknown) {
    const input = asCronCreateInput(payload, this.deliveryChannelProjection);
    if (!input) {
      throw new Error('Invalid cron create payload');
    }
    const deliveryValidationError = getCronDeliveryValidationError(input.delivery, this.deliveryChannelProjection);
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
    return result ?? created;
  }

  async executeUpdateJob(jobId: string, payload: unknown) {
    const patchResult = this.buildUpdatePatch(jobId, payload);
    if (!patchResult.ok) {
      throw new Error(patchResult.error);
    }
    const result = await this.deps.gateway.updateCronJob(jobId, patchResult.patch);
    await this.refreshJobsSnapshot();
    return result;
  }

  async executeDeleteJob(jobId: string) {
    const result = await this.deps.gateway.removeCronJob(jobId);
    await this.refreshJobsSnapshot();
    return result;
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

  async executeTrigger(payload: unknown) {
    const body = isRecord(payload) ? payload : null;
    if (!body || typeof body.id !== 'string') {
      throw new Error('Invalid cron trigger payload');
    }
    const result = await this.deps.scheduledAgentTriggerWorkflow.execute({ id: body.id });
    await this.refreshJobsSnapshot();
    return result;
  }

  buildUpdatePatch(jobId: string, payload: unknown): CronUpdatePatchResult {
    const input = isRecord(payload) ? payload : null;
    if (!input) {
      return {
        ok: false,
        error: 'Invalid cron update payload',
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
      const agentId = normalizeCronAgentId(patch.agentId);
      if (!agentId) {
        return {
          ok: false,
          error: 'agentId is required',
        };
      }
      patch.agentId = agentId;
    }
    if ('delivery' in patch) {
      patch.delivery = normalizeCronDeliveryPatch(patch.delivery, this.deliveryChannelProjection);
      const deliveryPatch = isRecord(patch.delivery) ? patch.delivery : {};
      const currentDelivery = this.getJobDelivery(jobId);
      const mergedDelivery = mergeCronDelivery(currentDelivery, deliveryPatch, this.deliveryChannelProjection);
      const deliveryValidationError = getCronDeliveryValidationError(mergedDelivery, this.deliveryChannelProjection);
      if (deliveryValidationError) {
        return {
          ok: false,
          error: deliveryValidationError,
        };
      }
    }
    return {
      ok: true,
      patch,
    };
  }

  private currentSnapshotResponse(state: CronSnapshotState, refreshing: boolean) {
    return {
      success: true,
      ready: state.jobsSnapshotReady,
      refreshing,
      updatedAt: state.jobsSnapshotUpdatedAt,
      error: state.jobsSnapshotError,
      jobs: state.jobsSnapshot,
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
    };
  }

  private getJobDelivery(jobId: string): GatewayCronDelivery {
    const state = this.getSnapshotState();
    const matchedJobRaw = state.jobsSnapshot.find((job) => isRecord(job) && job.id === jobId);
    const matchedJob = isRecord(matchedJobRaw) ? matchedJobRaw : null;
    if (!matchedJob || !isRecord(matchedJob.delivery)) {
      return { mode: 'none' };
    }
    return normalizeCronDelivery(matchedJob.delivery, this.deliveryChannelProjection);
  }
}
