import type { AgentScope, RuntimeInstanceScope } from '@/types/desktop/runtime-address';
import type { TeamSourceType } from '@/plugins/teams/services/team-runtime-client';
import type { ManualTeamProvisionRecord } from './team-creation';

export interface TeamMeta {
  id: string;
  runtimeScope?: AgentScope | RuntimeInstanceScope;
  name: string;
  teamSkillName: string;
  teamSkillVersion: string;
  teamSkillDescription: string;
  packagePath: string;
  sourcePath: string;
  sourceType?: TeamSourceType;
  manualTeam?: ManualTeamProvisionRecord;
  activeRunId?: string;
  createdAt: number;
  updatedAt: number;
}
