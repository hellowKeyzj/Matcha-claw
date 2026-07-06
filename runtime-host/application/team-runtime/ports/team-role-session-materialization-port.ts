import type { TeamRoleSessionBinding } from '../domain/team-run';

export interface TeamRoleEndpointSessionMaterializationPort {
  resolveEndpointSessionId(binding: TeamRoleSessionBinding): string;
  materializeEndpointSession(binding: TeamRoleSessionBinding): Promise<void>;
  dematerializeEndpointSession(binding: TeamRoleSessionBinding): Promise<void>;
}
