import { describe, expect, it, vi } from 'vitest';
import { createTeamSkillTransport } from '../../electron/main/runtime-host-delivery/transport/teams/skill';

const selectionId = `teamskill:v1:${'a'.repeat(64)}` as const;
const teamId = 'team:writing';
const idempotencyKey = 'materialize:writing:1';
const unavailable = { success: false, error: 'TeamSkill selection is unavailable' };

describe('Electron Main TeamSkill transport', () => {
  it('signs and sends fixed authorization and selection requests', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({ selectionId }) })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          status: 'valid',
          package: { selectionId, name: 'Writing Team', version: '1.0.0', kind: 'team-skill', description: 'Writes' },
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          status: 'available',
          plan: {
            selectionId,
            packageName: 'Writing Team',
            packageVersion: '1.0.0',
            items: [],
            canProceed: true,
          },
        }),
      })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ status: 'materialized' }) });
    const transport = createTeamSkillTransport({ verificationKey: 'public', signDecision }, 34_128, fetcher);

    await expect(transport.authorize('E:/skills/writing')).resolves.toEqual({ status: 200, body: { selectionId } });
    await expect(transport.validate(selectionId)).resolves.toMatchObject({ status: 200, body: { status: 'valid' } });
    await expect(transport.dependencyPlan(selectionId)).resolves.toMatchObject({ status: 200, body: { status: 'available' } });
    await expect(transport.materialize(selectionId, teamId, idempotencyKey)).resolves.toEqual({ status: 200, body: { status: 'materialized' } });

    expect(signDecision).toHaveBeenNthCalledWith(1, expect.objectContaining({
      endpoint: '/api/team/skill', scope: 'team:write', capability: 'team.skill.authorize', subject: 'team-skill-selection',
    }));
    expect(signDecision).toHaveBeenNthCalledWith(2, expect.objectContaining({ capability: 'team.skill.validate' }));
    expect(signDecision).toHaveBeenNthCalledWith(3, expect.objectContaining({ capability: 'team.skill.dependency-plan' }));
    expect(signDecision).toHaveBeenNthCalledWith(4, expect.objectContaining({ capability: 'team.skill.materialize' }));
    expect(fetcher).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:34128/api/team/skill', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: JSON.stringify({ operation: 'team.skill.authorize', packageRoot: 'E:/skills/writing' }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:34128/api/team/skill', expect.objectContaining({
      body: JSON.stringify({ operation: 'team.skill.validate', selectionId }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(3, 'http://127.0.0.1:34128/api/team/skill', expect.objectContaining({
      body: JSON.stringify({ operation: 'team.skill.dependency-plan', selectionId }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(4, 'http://127.0.0.1:34128/api/team/skill', expect.objectContaining({
      body: JSON.stringify({ operation: 'team.skill.materialize', selectionId, teamId, idempotencyKey }),
    }));
  });

  it('does not sign invalid selection or materialize requests', async () => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createTeamSkillTransport({ verificationKey: 'public', signDecision }, 34_128, fetcher);

    await expect(transport.validate('not-a-selection')).resolves.toEqual({ status: 503, body: unavailable });
    await expect(transport.materialize(selectionId, 'team/invalid', idempotencyKey)).resolves.toEqual({ status: 503, body: unavailable });
    await expect(transport.materialize(selectionId, teamId, 'idempotency key')).resolves.toEqual({ status: 503, body: unavailable });

    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('collapses malformed and private native responses to unavailable', async () => {
    const malformed = createTeamSkillTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_128,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ selectionId, sourcePath: 'E:/private' }) }),
    );
    const failed = createTeamSkillTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_128,
      vi.fn().mockRejectedValue(new Error('private loopback failure')),
    );

    await expect(malformed.dependencyPlan(selectionId)).resolves.toEqual({ status: 503, body: unavailable });
    await expect(malformed.materialize(selectionId, teamId, idempotencyKey)).resolves.toEqual({ status: 503, body: unavailable });
    const response = await failed.validate(selectionId);
    expect(response).toEqual({ status: 503, body: unavailable });
    expect(JSON.stringify(response)).not.toContain('private loopback failure');
  });
});
