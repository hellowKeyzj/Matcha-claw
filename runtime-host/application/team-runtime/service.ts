import { join } from 'node:path';
import type { TeamRuntimeOperationsWorkflow } from '../workflows/team-runtime/team-runtime-operations-workflow';

export class TeamRuntimeService {
  constructor(private readonly operationsWorkflow: TeamRuntimeOperationsWorkflow) {}

  async init(payload: unknown) {
    return await this.operationsWorkflow.init(payload);
  }

  async snapshot(payload: unknown) {
    return await this.operationsWorkflow.snapshot(payload);
  }

  async planUpsert(payload: unknown) {
    return await this.operationsWorkflow.planUpsert(payload);
  }

  async claimNext(payload: unknown) {
    return await this.operationsWorkflow.claimNext(payload);
  }

  async heartbeat(payload: unknown) {
    return await this.operationsWorkflow.heartbeat(payload);
  }

  async taskUpdate(payload: unknown) {
    return await this.operationsWorkflow.taskUpdate(payload);
  }

  async mailboxPost(payload: unknown) {
    return await this.operationsWorkflow.mailboxPost(payload);
  }

  async mailboxPull(payload: unknown) {
    return await this.operationsWorkflow.mailboxPull(payload);
  }

  async releaseClaim(payload: unknown) {
    return await this.operationsWorkflow.releaseClaim(payload);
  }

  async reset(payload: unknown) {
    return await this.operationsWorkflow.reset(payload);
  }

  async listTasks(payload: unknown) {
    return await this.operationsWorkflow.listTasks(payload);
  }
}

export interface TeamRuntimeStorageRootPort {
  getRuntimeDataRootDir(): string;
}

export function createTeamRuntimeRootResolver(storageRoot: TeamRuntimeStorageRootPort) {
  return (teamId: string) => join(storageRoot.getRuntimeDataRootDir(), 'team-runtime', teamId);
}
