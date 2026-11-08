import type { AccessGrant, AccessMember, AccessResource, AccessRole, AccessSnapshot } from '@/types/resource-access';
import type { SharedCapability } from '@/types/desktop/interconnect';

export type AccessSection = 'resources' | 'members' | 'roles';
export type Translate = (key: string, values?: Record<string, unknown>) => string;

export function groupCapabilities<T extends Pick<SharedCapability, 'sourceId' | 'presentation'>>(capabilities: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const capability of capabilities) {
    const group = capability.presentation;
    const key = group ? JSON.stringify([group.kind, group.targetId]) : capability.sourceId;
    const entries = groups.get(key) ?? [];
    if (!groups.has(key)) groups.set(key, entries);
    entries.push(capability);
  }
  return [...groups.values()];
}

export function capabilityOperation(capability: SharedCapability, t: Translate): string {
  const presentation = capability.presentation;
  const operations: Record<NonNullable<SharedCapability['presentation']>['kind'], readonly string[]> = { runtime: ['runtime.list'], agent: ['agent.ask'], wiki: ['wiki.read', 'wiki.search'], folder: ['folder.list', 'folder.read', 'folder.write'], plugin: [] };
  return presentation && operations[presentation.kind].includes(presentation.operation) ? t(`interop.operations.${presentation.operation}`) : capability.name;
}

export function capabilityName(capability: SharedCapability, t: Translate): string {
  return capability.presentation ? `${capability.presentation.targetName} · ${capabilityOperation(capability, t)}` : capability.name;
}

export function roleName(role: AccessRole, t: Translate): string {
  return role.name === 'admin' || role.name === 'member' ? t(`defaultRoles.${role.name}`) : role.name;
}

export function subjectName(subject: AccessGrant['subject'], snapshot: AccessSnapshot, t: Translate): string {
  return subject.kind === 'role'
    ? roleName(snapshot.roles.find((role) => role.id === subject.id)!, t)
    : snapshot.members.find((member) => member.id === subject.id)!.name;
}

export function memberAccess(resource: AccessResource, member: AccessMember, snapshot: AccessSnapshot, t: Translate): string[] {
  const reasons: string[] = [];
  if (resource.ownerId === member.id) reasons.push(t('owner'));
  for (const grant of snapshot.grants) {
    if (grant.resourceId !== resource.id) continue;
    if (grant.subject.kind === 'member' && grant.subject.id === member.id) reasons.push(t('directGrant'));
    if (grant.subject.kind === 'role' && member.roleIds.includes(grant.subject.id)) reasons.push(t('viaRole', { name: subjectName(grant.subject, snapshot, t) }));
  }
  return reasons;
}
