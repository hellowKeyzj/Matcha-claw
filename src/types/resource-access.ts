export const ACCESS_HOST_NAME_MAX_LENGTH = 64;

export interface AccessHost {
  id: string;
  name: string;
}

export interface AccessMember {
  id: string;
  name: string;
  enabled: boolean;
  roleIds: string[];
}

export interface AccessRole {
  id: string;
  name: string;
}

export interface AccessResource {
  id: string;
  name: string;
  host: AccessHost;
  ownerId: string;
  providerId: string;
  sourceId: string;
  state: 'active' | 'paused';
}

export interface AccessGrant {
  id: string;
  resourceId: string;
  subject: { kind: 'member' | 'role'; id: string };
}

export interface AccessSnapshot {
  revision: number;
  localMemberId: string;
  host: AccessHost;
  members: AccessMember[];
  roles: AccessRole[];
  resources: AccessResource[];
  grants: AccessGrant[];
}

export type AccessChange =
  | { kind: 'host.rename'; name: string }
  | { kind: 'member.update'; id: string; name: string; enabled: boolean; roleIds: string[] }
  | { kind: 'role.create'; name: string }
  | { kind: 'resource.capability'; name: string; sourceId: string }
  | { kind: 'resource.state'; id: string; state: 'active' | 'paused' }
  | { kind: 'resource.delete'; id: string }
  | { kind: 'grant.create'; resourceId: string; subject: AccessGrant['subject'] }
  | { kind: 'grant.revoke'; id: string };

export interface AccessCommand {
  expectedRevision: number;
  change: AccessChange;
}

export interface AccessDiscoverRequest {
  credential: string;
}

export interface AccessDiscovery {
  resources: AccessResource[];
}

export interface AccessAdmitRequest {
  callId: string;
  resourceId: string;
  sourceId: string;
  argumentsHash: string;
  credential: string;
}

export interface AccessAdmission {
  callId: string;
  resourceId: string;
  sourceId: string;
  argumentsHash: string;
}

export type AccessErrorCode = 'invalid-request' | 'unauthorized' | 'forbidden' | 'not-found' | 'conflict' | 'unavailable' | 'outcome-unknown';
export interface AccessFailure {
  success: false;
  error: AccessErrorCode;
}

export type AccessResponse<T> = { status: 200; body: T }
  | { status: 400 | 401 | 403 | 404 | 409 | 503; body: AccessFailure };
