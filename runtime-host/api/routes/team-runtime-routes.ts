import { createTeamRuntimeRootResolver, createTeamRuntimeService } from '../../application/team-runtime/service';
import { getOpenClawConfigDir } from '../storage/paths';

export async function handleTeamRuntimeRoute(method: string, routePath: string, payload: unknown) {
  if (method !== 'POST') {
    return null;
  }

  const service = createTeamRuntimeService(createTeamRuntimeRootResolver(getOpenClawConfigDir));

  if (routePath === '/api/team-runtime/init') {
    return {
      status: 200,
      data: await service.init(payload),
    };
  }

  if (routePath === '/api/team-runtime/snapshot') {
    return {
      status: 200,
      data: await service.snapshot(payload),
    };
  }

  if (routePath === '/api/team-runtime/plan-upsert') {
    return {
      status: 200,
      data: await service.planUpsert(payload),
    };
  }

  if (routePath === '/api/team-runtime/claim-next') {
    return {
      status: 200,
      data: await service.claimNext(payload),
    };
  }

  if (routePath === '/api/team-runtime/heartbeat') {
    return {
      status: 200,
      data: await service.heartbeat(payload),
    };
  }

  if (routePath === '/api/team-runtime/task-update') {
    return {
      status: 200,
      data: await service.taskUpdate(payload),
    };
  }

  if (routePath === '/api/team-runtime/mailbox-post') {
    return {
      status: 200,
      data: await service.mailboxPost(payload),
    };
  }

  if (routePath === '/api/team-runtime/mailbox-pull') {
    return {
      status: 200,
      data: await service.mailboxPull(payload),
    };
  }

  if (routePath === '/api/team-runtime/release-claim') {
    return {
      status: 200,
      data: await service.releaseClaim(payload),
    };
  }

  if (routePath === '/api/team-runtime/reset') {
    return {
      status: 200,
      data: await service.reset(payload),
    };
  }

  if (routePath === '/api/team-runtime/list-tasks') {
    return {
      status: 200,
      data: await service.listTasks(payload),
    };
  }

  return null;
}
