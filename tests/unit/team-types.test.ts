import { describe, it, expect } from 'vitest';
import type { TeamReport, Team } from '@/types/team';

describe('team types', () => {
  it('loads team types module', async () => {
    await expect(import('@/types/team')).resolves.toBeDefined();
  });

  it('accepts required Team fields', () => {
    const team: Team = {
      id: 't1',
      name: 'Team',
      controllerId: 'main',
      memberIds: ['main'],
      createdAt: 1,
      updatedAt: 1,
    };
    expect(team.controllerId).toBe('main');
  });

  it('accepts required TeamReport fields', () => {
    const report: TeamReport = {
      reportId: 'r1',
      task_id: 't1',
      agent_id: 'a1',
      status: 'done',
      result: ['x'],
    };
    expect(report.result.length).toBe(1);
  });
});
