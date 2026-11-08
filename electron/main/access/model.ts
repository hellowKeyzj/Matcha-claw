import type { AccessChange, AccessErrorCode, AccessResponse } from '../../../src/types/resource-access';

export interface Member {
  id: string;
  name: string;
  enabled: boolean;
  role_ids: string[];
  credential_hash: number[] | null;
}

export interface SharedFolderBinding {
  id: string;
  name: string;
  root: string;
  operation: import('../../../src/types/desktop/interconnect').SharedFolderOperation;
}

export interface FolderRegistration {
  expectedRevision: number;
  resources: { name: string; sourceId: string; folder: SharedFolderBinding }[];
}

export interface Resource {
  id: string;
  name: string;
  owner_id: string;
  provider_id: string;
  source_id: string;
  service: { kind: 'http'; port: number } | null;
  folder?: SharedFolderBinding;
  state: 'active' | 'paused';
}

// Keep the existing SQLite encoding; changing its owner does not migrate user data.
export interface Facts {
  host_id: string;
  host_name: string;
  local_member_id: string;
  members: Member[];
  roles: { id: string; name: string }[];
  resources: Resource[];
  grants: { id: string; resource_id: string; subject: { kind: 'member' | 'role'; id: string } }[];
}

export interface State {
  revision: number;
  facts: Facts;
}

export interface MemberCreation {
  expectedRevision: number;
  name: string;
  credential: string;
}

export interface Mutation {
  expectedRevision: number;
  change: AccessChange | { kind: 'member.create'; name: string; credential: string }
    | { kind: 'resource.folder'; resources: FolderRegistration['resources'] };
}

export class AccessError extends Error {
  constructor(readonly code: AccessErrorCode) { super(code); }
}

const STATUS = {
  'invalid-request': 400, unauthorized: 401, forbidden: 403, 'not-found': 404,
  conflict: 409, unavailable: 503, 'outcome-unknown': 503,
} as const;

export function failure(code: AccessErrorCode): AccessResponse<never> {
  return { status: STATUS[code], body: { success: false, error: code } };
}
