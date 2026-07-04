import type { TeamRoleSessionBinding } from '../domain/team-run';

export interface TeamRoleEndpointSessionMaterializationPort {
  materializeEndpointSession(binding: TeamRoleSessionBinding): Promise<void>;
}
