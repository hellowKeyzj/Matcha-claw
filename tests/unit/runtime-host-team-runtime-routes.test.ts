import { describe, expect, it, vi } from 'vitest';
import { teamRuntimeRoutes } from '../../runtime-host/api/routes/team-runtime-routes';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

describe('runtime-host team runtime routes', () => {
  it('routes through the injected service instead of constructing runtime dependencies', async () => {
    const service = {
      init: vi.fn(async () => ({ ok: true })),
      snapshot: vi.fn(),
      planUpsert: vi.fn(),
      claimNext: vi.fn(),
      heartbeat: vi.fn(),
      taskUpdate: vi.fn(),
      mailboxPost: vi.fn(),
      mailboxPull: vi.fn(),
      releaseClaim: vi.fn(),
      reset: vi.fn(),
      listTasks: vi.fn(),
    };

    const response = await dispatchRuntimeRouteDefinition(teamRuntimeRoutes, 
      'POST',
      '/api/team-runtime/init',
      { teamId: 'team-1', leadAgentId: 'lead' },
      service,
    );

    expect(response).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(service.init).toHaveBeenCalledWith({ teamId: 'team-1', leadAgentId: 'lead' });
  });
});
