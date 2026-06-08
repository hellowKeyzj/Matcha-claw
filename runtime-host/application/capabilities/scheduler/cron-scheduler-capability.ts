import type { CronService } from '../../cron/service';
import { badRequest } from '../../common/application-response';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute, CapabilityOperationContext } from '../contracts/capability-router';

export const SCHEDULER_CRON_CAPABILITY_ID = 'scheduler.cron';

export const cronSchedulerCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'cron.create', title: 'Create cron job', targetKind: 'cron-job' },
  { id: 'cron.update', title: 'Update cron job', targetKind: 'cron-job' },
  { id: 'cron.delete', title: 'Delete cron job', targetKind: 'cron-job' },
  { id: 'cron.toggle', title: 'Toggle cron job', targetKind: 'cron-job' },
  { id: 'cron.trigger', title: 'Trigger cron job', targetKind: 'cron-job' },
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
      handle: (context) => {
        const targetError = validateCronJobTargetInput(context, 'jobId');
        return targetError ? badRequest(targetError) : deps.cronService.updateJob(readJobId(context.domainInput), readUpdates(context.domainInput));
      },
    },
    {
      capabilityId: SCHEDULER_CRON_CAPABILITY_ID,
      operationId: 'cron.delete',
      handle: (context) => {
        const targetError = validateCronJobTargetInput(context, 'jobId');
        return targetError ? badRequest(targetError) : deps.cronService.deleteJob(readJobId(context.domainInput));
      },
    },
    {
      capabilityId: SCHEDULER_CRON_CAPABILITY_ID,
      operationId: 'cron.toggle',
      handle: (context) => {
        const targetError = validateCronJobTargetInput(context, 'id');
        return targetError ? badRequest(targetError) : deps.cronService.toggleJob(context.domainInput);
      },
    },
    {
      capabilityId: SCHEDULER_CRON_CAPABILITY_ID,
      operationId: 'cron.trigger',
      handle: (context) => {
        const targetError = validateCronJobTargetInput(context, 'id');
        return targetError ? badRequest(targetError) : deps.cronService.trigger(context.domainInput);
      },
    },
  ];
}

function validateCronJobTargetInput(context: CapabilityOperationContext, inputKey: 'jobId' | 'id'): string | null {
  if (context.target?.kind !== 'cron-job') {
    return 'Capability target kind must be cron-job';
  }
  const targetJobId = readString(context.target.jobId);
  const inputJobId = readString(context.domainInput[inputKey]);
  if (!targetJobId || !inputJobId) {
    return `Capability target jobId and input ${inputKey} are required`;
  }
  return targetJobId === inputJobId
    ? null
    : `Capability target jobId must match input ${inputKey}`;
}

function readJobId(payload: Record<string, unknown>): string {
  return readString(payload.jobId);
}

function readUpdates(payload: Record<string, unknown>): unknown {
  return payload.updates;
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}
