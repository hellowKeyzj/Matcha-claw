import type { CronService } from '../../cron/service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const SCHEDULER_CRON_CAPABILITY_ID = 'scheduler.cron';

export const cronSchedulerCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'cron.create', title: 'Create cron job' },
  { id: 'cron.update', title: 'Update cron job' },
  { id: 'cron.delete', title: 'Delete cron job' },
  { id: 'cron.toggle', title: 'Toggle cron job' },
  { id: 'cron.trigger', title: 'Trigger cron job' },
] as const;

export function createCronSchedulerCapabilityOperationRoutes(deps: {
  cronService: Pick<CronService, 'createJob' | 'updateJob' | 'deleteJob' | 'toggleJob' | 'trigger'>;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: SCHEDULER_CRON_CAPABILITY_ID,
      operationId: 'cron.create',
      handle: (context) => deps.cronService.createJob(context.domainInput),
    },
    {
      capabilityId: SCHEDULER_CRON_CAPABILITY_ID,
      operationId: 'cron.update',
      handle: (context) => deps.cronService.updateJob(readJobId(context.domainInput), readUpdates(context.domainInput)),
    },
    {
      capabilityId: SCHEDULER_CRON_CAPABILITY_ID,
      operationId: 'cron.delete',
      handle: (context) => deps.cronService.deleteJob(readJobId(context.domainInput)),
    },
    {
      capabilityId: SCHEDULER_CRON_CAPABILITY_ID,
      operationId: 'cron.toggle',
      handle: (context) => deps.cronService.toggleJob(context.domainInput),
    },
    {
      capabilityId: SCHEDULER_CRON_CAPABILITY_ID,
      operationId: 'cron.trigger',
      handle: (context) => deps.cronService.trigger(context.domainInput),
    },
  ];
}

function readJobId(payload: Record<string, unknown>): string {
  return typeof payload.jobId === 'string' ? payload.jobId : '';
}

function readUpdates(payload: Record<string, unknown>): unknown {
  return payload.updates;
}
