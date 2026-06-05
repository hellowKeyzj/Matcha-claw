import type { CronOperationsWorkflow } from '../workflows/cron/cron-operations-workflow';
import { CronSessionHistoryService } from './cron-session-history';

export interface CronServiceDeps {
  readonly sessionHistory: Pick<CronSessionHistoryService, 'read'>;
  readonly operationsWorkflow: Pick<
    CronOperationsWorkflow,
    | 'usageRecent'
    | 'listJobs'
    | 'refreshJobsSnapshot'
    | 'executeDeliveryRepair'
    | 'createJob'
    | 'executeCreateJob'
    | 'updateJob'
    | 'executeUpdateJob'
    | 'deleteJob'
    | 'executeDeleteJob'
    | 'toggleJob'
    | 'executeToggleJob'
    | 'trigger'
    | 'executeTrigger'
  >;
}

export class CronService {
  constructor(private readonly deps: CronServiceDeps) {}

  async usageRecent(payload: unknown, routeUrl: URL) {
    return await this.deps.operationsWorkflow.usageRecent(payload, routeUrl);
  }

  async listJobs() {
    return await this.deps.operationsWorkflow.listJobs();
  }

  async refreshJobsSnapshot() {
    return await this.deps.operationsWorkflow.refreshJobsSnapshot();
  }

  async executeDeliveryRepair() {
    return await this.deps.operationsWorkflow.executeDeliveryRepair();
  }

  async sessionHistory(routeUrl: URL) {
    return await this.deps.sessionHistory.read(routeUrl);
  }

  async createJob(payload: unknown) {
    return await this.deps.operationsWorkflow.createJob(payload);
  }

  async executeCreateJob(payload: unknown) {
    return await this.deps.operationsWorkflow.executeCreateJob(payload);
  }

  async updateJob(jobId: string, payload: unknown) {
    return await this.deps.operationsWorkflow.updateJob(jobId, payload);
  }

  async executeUpdateJob(jobId: string, payload: unknown) {
    return await this.deps.operationsWorkflow.executeUpdateJob(jobId, payload);
  }

  async deleteJob(jobId: string) {
    return await this.deps.operationsWorkflow.deleteJob(jobId);
  }

  async executeDeleteJob(jobId: string) {
    return await this.deps.operationsWorkflow.executeDeleteJob(jobId);
  }

  toggleJob(payload: unknown) {
    return this.deps.operationsWorkflow.toggleJob(payload);
  }

  async executeToggleJob(payload: unknown) {
    return await this.deps.operationsWorkflow.executeToggleJob(payload);
  }

  trigger(payload: unknown) {
    return this.deps.operationsWorkflow.trigger(payload);
  }

  async executeTrigger(payload: unknown) {
    return await this.deps.operationsWorkflow.executeTrigger(payload);
  }
}
