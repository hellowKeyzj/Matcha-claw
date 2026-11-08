import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ACCESS_HOST_NAME_MAX_LENGTH } from '../../../src/types/resource-access';
import type {
  AccessAdmission, AccessAdmitRequest, AccessDiscoverRequest, AccessDiscovery,
  AccessResource, AccessSnapshot,
} from '../../../src/types/resource-access';
import { AccessError, type Facts, type Member, type Mutation, type Resource, type State } from './model';
import { isSha256Hex, isValidText, parseUuid } from './validation';

export function initialFacts(): Facts {
  const hostId = randomUUID();
  const environmentName = process.env[process.platform === 'win32' ? 'COMPUTERNAME' : 'HOSTNAME'];
  const hostName = environmentName !== undefined && isValidText(environmentName, 256) ? environmentName : hostId;
  const localMemberId = randomUUID();
  const adminId = randomUUID();
  return {
    host_id: hostId,
    host_name: hostName,
    local_member_id: localMemberId,
    members: [{ id: localMemberId, name: hostName, enabled: true, role_ids: [adminId], credential_hash: null }],
    roles: [{ id: adminId, name: 'admin' }, { id: randomUUID(), name: 'member' }],
    resources: [],
    grants: [],
  };
}

function validateName(name: string): void {
  if (!isValidText(name, 256)) throw new AccessError('invalid-request');
}

function credentialDigest(credential: string): Buffer {
  if (!isSha256Hex(credential)) throw new AccessError('invalid-request');
  return createHash('sha256').update(credential, 'utf8').digest();
}

function checkCredentialAvailable(facts: Facts, hash: Buffer): void {
  if (facts.members.some(member => member.credential_hash !== null
    && timingSafeEqual(Buffer.from(member.credential_hash), hash))) {
    throw new AccessError('conflict');
  }
}

export function applyChange(facts: Facts, change: Mutation['change']): void {
  switch (change.kind) {
    case 'host.rename': {
      if (change.name.length > ACCESS_HOST_NAME_MAX_LENGTH) throw new AccessError('invalid-request');
      validateName(change.name);
      facts.host_name = change.name;
      return;
    }
    case 'member.create': {
      validateName(change.name);
      const hash = credentialDigest(change.credential);
      checkCredentialAvailable(facts, hash);
      facts.members.push({
        id: randomUUID(), name: change.name, enabled: true, role_ids: [], credential_hash: Array.from(hash),
      });
      return;
    }
    case 'member.update': {
      const id = parseUuid(change.id);
      validateName(change.name);
      const roleIds = change.roleIds.map(parseUuid);
      for (let index = 0; index < roleIds.length; index++) {
        if (roleIds.indexOf(roleIds[index]) !== index) throw new AccessError('invalid-request');
        if (!facts.roles.some(role => role.id === roleIds[index])) throw new AccessError('not-found');
      }
      const member = facts.members.find(member => member.id === id);
      if (!member) throw new AccessError('not-found');
      member.name = change.name;
      member.enabled = change.enabled;
      member.role_ids = roleIds;
      return;
    }
    case 'role.create': {
      validateName(change.name);
      if (facts.roles.some(role => role.name === change.name)) throw new AccessError('conflict');
      facts.roles.push({ id: randomUUID(), name: change.name });
      return;
    }
    case 'resource.capability': {
      validateName(change.name);
      if (!isValidText(change.sourceId, 4096)) throw new AccessError('invalid-request');
      if (facts.resources.some(resource => resource.provider_id === 'capability' && resource.source_id === change.sourceId)) {
        throw new AccessError('conflict');
      }
      facts.resources.push({
        id: randomUUID(), name: change.name, owner_id: facts.local_member_id,
        provider_id: 'capability', source_id: change.sourceId, service: null, state: 'active',
      });
      return;
    }
    case 'resource.folder': {
      if (!change.resources.length || change.resources.length > 3) throw new AccessError('invalid-request');
      const [first] = change.resources;
      for (const resource of change.resources) {
        validateName(resource.name);
        validateName(resource.folder.name);
        if (!isValidText(resource.sourceId, 4096) || resource.folder.id !== first.folder.id
          || resource.folder.root !== first.folder.root || resource.folder.name !== first.folder.name) {
          throw new AccessError('invalid-request');
        }
        if (facts.resources.some((existing) => existing.folder
          && (existing.folder.id === resource.folder.id && (existing.folder.root !== resource.folder.root || existing.folder.name !== resource.folder.name)
            || existing.folder.root === resource.folder.root && existing.folder.id !== resource.folder.id))) throw new AccessError('conflict');
        if (facts.resources.some((existing) => existing.source_id === resource.sourceId
          || (existing.folder?.id === resource.folder.id && existing.folder.operation === resource.folder.operation)
          || (existing.folder?.root === resource.folder.root && existing.folder.operation === resource.folder.operation))) {
          throw new AccessError('conflict');
        }
        facts.resources.push({
          id: randomUUID(), name: resource.name, owner_id: facts.local_member_id,
          provider_id: 'capability', source_id: resource.sourceId, service: null,
          folder: { ...resource.folder }, state: 'active',
        });
      }
      return;
    }
    case 'resource.state': {
      const id = parseUuid(change.id);
      const resource = facts.resources.find(resource => resource.id === id);
      if (!resource) throw new AccessError('not-found');
      resource.state = change.state;
      return;
    }
    case 'resource.delete': {
      const id = parseUuid(change.id);
      const index = facts.resources.findIndex(resource => resource.id === id);
      if (index === -1) throw new AccessError('not-found');
      facts.resources.splice(index, 1);
      facts.grants = facts.grants.filter(grant => grant.resource_id !== id);
      return;
    }
    case 'grant.create': {
      const resourceId = parseUuid(change.resourceId);
      const subject = { kind: change.subject.kind, id: parseUuid(change.subject.id) };
      if (!facts.resources.some(resource => resource.id === resourceId)) throw new AccessError('not-found');
      const subjects = subject.kind === 'member' ? facts.members : facts.roles;
      if (!subjects.some(candidate => candidate.id === subject.id)) throw new AccessError('not-found');
      if (facts.grants.some(grant => grant.resource_id === resourceId
        && grant.subject.kind === subject.kind && grant.subject.id === subject.id)) {
        throw new AccessError('conflict');
      }
      facts.grants.push({ id: randomUUID(), resource_id: resourceId, subject });
      return;
    }
    case 'grant.revoke': {
      const id = parseUuid(change.id);
      const index = facts.grants.findIndex(grant => grant.id === id);
      if (index === -1) throw new AccessError('not-found');
      facts.grants.splice(index, 1);
      return;
    }
  }
}

function projectResource(facts: Facts, resource: Resource): AccessResource {
  return {
    id: resource.id, name: resource.name, host: { id: facts.host_id, name: facts.host_name },
    ownerId: resource.owner_id, providerId: resource.provider_id, sourceId: resource.source_id,
    state: resource.state,
  };
}

export function snapshot(state: State): AccessSnapshot {
  const facts = state.facts;
  const resources = facts.resources.filter(resource => resource.provider_id === 'capability' && resource.service === null)
    .map(resource => projectResource(facts, resource));
  const resourceIds = new Set(resources.map(resource => resource.id));
  return {
    revision: state.revision,
    localMemberId: facts.local_member_id,
    host: { id: facts.host_id, name: facts.host_name },
    members: facts.members.map(member => ({
      id: member.id, name: member.id === facts.local_member_id ? facts.host_name : member.name, enabled: member.enabled,
      roleIds: [...member.role_ids],
    })),
    roles: facts.roles.map(role => ({ ...role })),
    resources,
    grants: facts.grants.filter(grant => resourceIds.has(grant.resource_id))
      .map(grant => ({ id: grant.id, resourceId: grant.resource_id, subject: { ...grant.subject } })),
  };
}

function authenticate(facts: Facts, credential: string): Member {
  if (!isSha256Hex(credential)) throw new AccessError('unauthorized');
  const hash = credentialDigest(credential);
  const member = facts.members.find(member => member.credential_hash !== null
    && timingSafeEqual(Buffer.from(member.credential_hash), hash));
  if (!member?.enabled) throw new AccessError('unauthorized');
  return member;
}

function isMemberAllowed(facts: Facts, member: Member, resource: Resource): boolean {
  return resource.owner_id === member.id || facts.grants.some(grant => grant.resource_id === resource.id
    && (grant.subject.kind === 'member' ? grant.subject.id === member.id : member.role_ids.includes(grant.subject.id)));
}

export function authorize(facts: Facts, resourceId: string, credential: string): Resource {
  const member = authenticate(facts, credential);
  const id = parseUuid(resourceId);
  const resource = facts.resources.find(resource => resource.id === id);
  if (!resource) throw new AccessError('not-found');
  if (resource.state === 'paused' || !isMemberAllowed(facts, member, resource)) throw new AccessError('forbidden');
  return resource;
}

export function discover(facts: Facts, request: AccessDiscoverRequest): AccessDiscovery {
  const member = authenticate(facts, request.credential);
  return {
    resources: facts.resources.filter(resource => resource.provider_id === 'capability' && resource.service === null
      && resource.state === 'active' && isMemberAllowed(facts, member, resource))
      .map(resource => projectResource(facts, resource)),
  };
}

export function admit(facts: Facts, request: AccessAdmitRequest): AccessAdmission {
  if (!isSha256Hex(request.argumentsHash)) throw new AccessError('invalid-request');
  const resource = authorize(facts, request.resourceId, request.credential);
  if (resource.provider_id !== 'capability' || resource.service !== null) throw new AccessError('invalid-request');
  if (resource.source_id !== request.sourceId) throw new AccessError('conflict');
  return {
    callId: request.callId, resourceId: resource.id, sourceId: resource.source_id, argumentsHash: request.argumentsHash,
  };
}

