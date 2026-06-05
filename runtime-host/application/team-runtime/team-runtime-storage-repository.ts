import type { TeamRuntimeStoragePort } from './types';
import * as mailboxStore from './mailbox-store';
import * as runtimeStore from './runtime-store';
import * as taskStore from './task-store';
import type { RuntimeClockPort, RuntimeFileSystemPort, RuntimeIdGeneratorPort } from '../common/runtime-ports';
import type { TeamRuntimeStorageContext } from './storage-context';

export class TeamRuntimeStorageRepository implements TeamRuntimeStoragePort {
  private readonly context: TeamRuntimeStorageContext;

  constructor(deps: {
    fileSystem: RuntimeFileSystemPort;
    idGenerator: RuntimeIdGeneratorPort;
    clock: RuntimeClockPort;
  }) {
    this.context = deps;
  }

  async initRun(input: Omit<Parameters<typeof runtimeStore.initTeamRun>[0], 'context'>) {
    return await runtimeStore.initTeamRun({ ...input, context: this.context });
  }

  async readRun(runtimeRoot: string) {
    return await runtimeStore.readTeamRun(this.context, runtimeRoot);
  }

  async appendEvent(input: Omit<Parameters<typeof runtimeStore.appendTeamEvent>[0], 'context'>) {
    return await runtimeStore.appendTeamEvent({ ...input, context: this.context });
  }

  async readRecentEvents(runtimeRoot: string, limit?: number) {
    return await runtimeStore.readRecentEvents(this.context, runtimeRoot, limit);
  }

  async upsertPlanTasks(input: Omit<Parameters<typeof taskStore.upsertPlanTasks>[0], 'context'>) {
    return await taskStore.upsertPlanTasks({ ...input, context: this.context });
  }

  async claimNextTask(input: Omit<Parameters<typeof taskStore.claimNextTask>[0], 'context'>) {
    return await taskStore.claimNextTask({ ...input, context: this.context });
  }

  async heartbeatTaskClaim(input: Omit<Parameters<typeof taskStore.heartbeatTaskClaim>[0], 'context'>) {
    return await taskStore.heartbeatTaskClaim({ ...input, context: this.context });
  }

  async updateTaskStatus(input: Omit<Parameters<typeof taskStore.updateTaskStatus>[0], 'context'>) {
    return await taskStore.updateTaskStatus({ ...input, context: this.context });
  }

  async mailboxPost(input: Omit<Parameters<typeof mailboxStore.mailboxPost>[0], 'context'>) {
    return await mailboxStore.mailboxPost({ ...input, context: this.context });
  }

  async mailboxPull(input: Omit<Parameters<typeof mailboxStore.mailboxPull>[0], 'context'>) {
    return await mailboxStore.mailboxPull({ ...input, context: this.context });
  }

  async releaseTaskClaim(input: Omit<Parameters<typeof taskStore.releaseTaskClaim>[0], 'context'>) {
    return await taskStore.releaseTaskClaim({ ...input, context: this.context });
  }

  async clearRuntime(runtimeRoot: string) {
    await runtimeStore.clearTeamRuntime(this.context, runtimeRoot);
  }

  async listTasks(runtimeRoot: string) {
    return await taskStore.listTasks(this.context, runtimeRoot);
  }
}
