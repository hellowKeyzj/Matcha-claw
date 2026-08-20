import { describe, expect, it, vi } from 'vitest';

const hostApiFetchDecodedMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetchDecoded: (...args: unknown[]) => hostApiFetchDecodedMock(...args),
}));

import { decodeDependencyPlan, decodeMaterialization, decodeValidation, materializeTeamSkillSelection } from '@/services/team-skill-selection';

const selectionId = `teamskill:v1:${'a'.repeat(64)}`;

describe('TeamSkill renderer selection DTO', () => {
  it('accepts the sealed validation and dependency plan projections', () => {
    expect(decodeValidation({
      status: 'valid',
      package: { selectionId, name: 'Writing Team', version: '1.0.0', kind: 'team-skill', description: 'Writes' },
    })).toMatchObject({ status: 'valid', package: { selectionId } });
    expect(decodeDependencyPlan({
      status: 'available',
      plan: {
        selectionId,
        packageName: 'Writing Team',
        packageVersion: '1.0.0',
        items: [{ kind: 'skill', name: 'writer', required: true, purpose: 'Drafts', status: 'available', severity: 'ok', installable: false }],
        canProceed: true,
      },
    })).toMatchObject({ status: 'available', plan: { selectionId } });
  });

  it('rejects root, source, and diagnostic fields in sealed projections', () => {
    expect(() => decodeValidation({
      status: 'valid',
      package: { selectionId, name: 'Writing Team', version: '1.0.0', kind: 'team-skill', description: 'Writes', sourcePath: 'E:/private' },
    })).toThrow('TeamSkill selection is unavailable');
    expect(() => decodeDependencyPlan({
      status: 'available',
      plan: {
        selectionId,
        packageName: 'Writing Team',
        packageVersion: '1.0.0',
        items: [{ kind: 'skill', name: 'writer', required: true, purpose: 'Drafts', status: 'available', severity: 'ok', installable: false, source: 'private' }],
        canProceed: true,
      },
    })).toThrow('TeamSkill selection is unavailable');
  });

  it('uses the fixed TeamSkill materialization request', async () => {
    const teamId = 'team-1';
    const idempotencyKey = 'team-1:team-skill-materialize';
    hostApiFetchDecodedMock.mockResolvedValueOnce({ status: 'materialized' });

    await expect(materializeTeamSkillSelection(selectionId, teamId, idempotencyKey)).resolves.toEqual({ status: 'materialized' });

    expect(hostApiFetchDecodedMock).toHaveBeenCalledWith('/api/team/skill', expect.any(Function), expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ operation: 'team.skill.materialize', selectionId, teamId, idempotencyKey }),
    }));
  });

  it('accepts only sealed materialization outcomes', () => {
    expect(decodeMaterialization({ status: 'materialized' })).toEqual({ status: 'materialized' });
    expect(decodeMaterialization({ status: 'rejected' })).toEqual({ status: 'rejected' });
    expect(decodeMaterialization({ status: 'outcome_unknown' })).toEqual({ status: 'outcome_unknown' });
    expect(() => decodeMaterialization({ status: 'materialized', receipt: 'private' })).toThrow('TeamSkill materialization is unavailable');
  });
});
