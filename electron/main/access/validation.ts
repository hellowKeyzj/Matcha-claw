import type {
  AccessAdmitRequest, AccessChange, AccessCommand, AccessDiscoverRequest,
  AccessGrant,
} from '../../../src/types/resource-access';
import { isAbsolute } from 'node:path';
import { AccessError, type Facts, type FolderRegistration, type Member, type MemberCreation, type Resource, type SharedFolderBinding } from './model';

function parseObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AccessError('invalid-request');
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new AccessError('invalid-request');
  }
  return value as Record<string, unknown>;
}

function parseString(value: unknown): string {
  // Rust strings cannot contain lone UTF-16 surrogates, including escaped JSON input.
  if (typeof value !== 'string' || /[\ud800-\udfff]/u.test(value)) throw new AccessError('invalid-request');
  return value;
}

function parseBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new AccessError('invalid-request');
  return value;
}

function parseInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AccessError('invalid-request');
  }
  return value;
}

function parseArray<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new AccessError('invalid-request');
  return Array.from(value, parse);
}

function parseEnum<T extends string>(value: unknown, choices: readonly T[]): T {
  const choice = choices.find(choice => choice === value);
  if (choice === undefined) throw new AccessError('invalid-request');
  return choice;
}

export function parseUuid(value: unknown): string {
  let id = parseString(value);
  // uuid 1.26 accepts a lowercase URN prefix and case-insensitive hexadecimal digits.
  if (id.length === 45 && id.startsWith('urn:uuid:')) id = id.slice(9);
  else if (id.length === 38 && id.startsWith('{') && id.endsWith('}')) id = id.slice(1, -1);
  if (id.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return id.toLowerCase();
  }
  if (id.length !== 32 || !/^[0-9a-f]{32}$/i.test(id)) throw new AccessError('invalid-request');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`.toLowerCase();
}

export function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

export function isValidText(value: string, maximumBytes: number): boolean {
  // Rust trim uses Unicode White_Space, unlike JS trim (notably U+0085 and U+FEFF).
  return /\P{White_Space}/u.test(value) && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !hasControlCharacters(value) && !/[\ud800-\udfff]/u.test(value);
}

export function isSha256Hex(value: string): boolean {
  return value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

function parseSubject(value: unknown): AccessGrant['subject'] {
  const subject = parseObject(value, ['kind', 'id']);
  return { kind: parseEnum(subject.kind, ['member', 'role']), id: parseString(subject.id) };
}

function parseService(value: unknown): NonNullable<Resource['service']> {
  const service = parseObject(value, ['kind', 'port']);
  return { kind: parseEnum(service.kind, ['http']), port: parseInteger(service.port, 1, 65535) };
}

function parseChange(value: unknown): AccessChange {
  const { kind } = parseObject(value, ['kind'], [
    'name', 'id', 'enabled', 'roleIds', 'sourceId', 'state', 'resourceId', 'subject',
  ]);
  switch (kind) {
    case 'member.update': {
      const change = parseObject(value, ['kind', 'id', 'name', 'enabled', 'roleIds']);
      return {
        kind, id: parseString(change.id), name: parseString(change.name),
        enabled: parseBoolean(change.enabled), roleIds: parseArray(change.roleIds, parseString),
      };
    }
    case 'host.rename':
    case 'role.create': {
      const change = parseObject(value, ['kind', 'name']);
      return { kind, name: parseString(change.name) };
    }
    case 'resource.capability': {
      const change = parseObject(value, ['kind', 'name', 'sourceId']);
      return { kind, name: parseString(change.name), sourceId: parseString(change.sourceId) };
    }
    case 'resource.state': {
      const change = parseObject(value, ['kind', 'id', 'state']);
      return { kind, id: parseString(change.id), state: parseEnum(change.state, ['active', 'paused']) };
    }
    case 'resource.delete': {
      const change = parseObject(value, ['kind', 'id']);
      return { kind, id: parseString(change.id) };
    }
    case 'grant.create': {
      const change = parseObject(value, ['kind', 'resourceId', 'subject']);
      return { kind, resourceId: parseString(change.resourceId), subject: parseSubject(change.subject) };
    }
    case 'grant.revoke': {
      const change = parseObject(value, ['kind', 'id']);
      return { kind, id: parseString(change.id) };
    }
    default: throw new AccessError('invalid-request');
  }
}

export function parseCommand(value: unknown): AccessCommand {
  const command = parseObject(value, ['expectedRevision', 'change']);
  return { expectedRevision: parseInteger(command.expectedRevision, 0, Number.MAX_SAFE_INTEGER), change: parseChange(command.change) };
}

export function parseMemberCreation(value: unknown): MemberCreation {
  const request = parseObject(value, ['expectedRevision', 'name', 'credential']);
  return {
    expectedRevision: parseInteger(request.expectedRevision, 0, Number.MAX_SAFE_INTEGER),
    name: parseString(request.name), credential: parseString(request.credential),
  };
}

export function parseDiscover(value: unknown): AccessDiscoverRequest {
  const request = parseObject(value, ['credential']);
  return { credential: parseString(request.credential) };
}

export function parseAdmit(value: unknown): AccessAdmitRequest {
  const request = parseObject(value, ['callId', 'resourceId', 'sourceId', 'argumentsHash', 'credential']);
  return {
    callId: parseUuid(request.callId), resourceId: parseString(request.resourceId), sourceId: parseString(request.sourceId),
    argumentsHash: parseString(request.argumentsHash), credential: parseString(request.credential),
  };
}

function parseMember(value: unknown): Member {
  const member = parseObject(value, ['id', 'name', 'enabled', 'role_ids'], ['credential_hash']);
  let hash: number[] | null = null;
  if (Object.hasOwn(member, 'credential_hash') && member.credential_hash !== null) {
    hash = parseArray(member.credential_hash, value => parseInteger(value, 0, 255));
    if (hash.length !== 32) throw new AccessError('invalid-request');
  }
  return {
    id: parseUuid(member.id), name: parseString(member.name), enabled: parseBoolean(member.enabled),
    role_ids: parseArray(member.role_ids, parseUuid), credential_hash: hash,
  };
}

function parseFolder(value: unknown): SharedFolderBinding {
  const folder = parseObject(value, ['id', 'name', 'root', 'operation']);
  const root = parseString(folder.root);
  const name = parseString(folder.name);
  if (!isAbsolute(root) || root.includes('\0') || root.length > 32_768 || !isValidText(name, 256)) throw new AccessError('invalid-request');
  return { id: parseUuid(folder.id), name, root, operation: parseEnum(folder.operation, ['list', 'read', 'write']) };
}

export function parseFolderRegistration(value: unknown): FolderRegistration {
  const request = parseObject(value, ['expectedRevision', 'resources']);
  const resources = parseArray(request.resources, (value) => {
    const resource = parseObject(value, ['name', 'sourceId', 'folder']);
    return { name: parseString(resource.name), sourceId: parseString(resource.sourceId), folder: parseFolder(resource.folder) };
  });
  return { expectedRevision: parseInteger(request.expectedRevision, 0, Number.MAX_SAFE_INTEGER), resources };
}

function parseResource(value: unknown): Resource {
  const resource = parseObject(value, ['id', 'name', 'owner_id', 'provider_id', 'source_id', 'state'], ['service', 'folder']);
  return {
    id: parseUuid(resource.id), name: parseString(resource.name), owner_id: parseUuid(resource.owner_id),
    provider_id: parseString(resource.provider_id), source_id: parseString(resource.source_id),
    service: Object.hasOwn(resource, 'service') && resource.service !== null ? parseService(resource.service) : null,
    ...(Object.hasOwn(resource, 'folder') ? { folder: parseFolder(resource.folder) } : {}),
    state: parseEnum(resource.state, ['active', 'paused']),
  };
}

export function parseFacts(value: unknown): Facts {
  const facts = parseObject(value, ['host_id', 'host_name', 'local_member_id', 'members', 'roles', 'resources', 'grants']);
  return {
    host_id: parseUuid(facts.host_id), host_name: parseString(facts.host_name), local_member_id: parseUuid(facts.local_member_id),
    members: parseArray(facts.members, parseMember),
    roles: parseArray(facts.roles, value => {
      const role = parseObject(value, ['id', 'name']);
      return { id: parseUuid(role.id), name: parseString(role.name) };
    }),
    resources: parseArray(facts.resources, parseResource),
    grants: parseArray(facts.grants, value => {
      const grant = parseObject(value, ['id', 'resource_id', 'subject']);
      const subject = parseSubject(grant.subject);
      return { id: parseUuid(grant.id), resource_id: parseUuid(grant.resource_id), subject: { ...subject, id: parseUuid(subject.id) } };
    }),
  };
}
