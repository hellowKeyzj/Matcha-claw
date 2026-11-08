import { useTranslation } from 'react-i18next';
import { Layers, Lock, Pause, Play, Plus, ShieldCheck, Trash2, UserRound, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AccessChange, AccessSnapshot } from '@/types/resource-access';
import type { SharedCapability } from '@/types/desktop/interconnect';
import { capabilityName, memberAccess, roleName, subjectName, type AccessSection } from './model';
import type { AccessForm } from './forms';
import { AccessStatus } from './ui';

export interface AccessConfirmation {
  title: string;
  message: string;
  label: string;
  change: AccessChange;
  revision: number;
}

export function AccessDetail({ section, id, snapshot, disabled, onClose, onForm, onConfirm, onSelect, capability }: {
  section: AccessSection; id: string; snapshot: AccessSnapshot; disabled: boolean; capability?: SharedCapability;
  onClose: () => void; onForm: (form: AccessForm) => void; onConfirm: (confirmation: AccessConfirmation) => void;
  onSelect: (section: AccessSection, id: string) => void;
}) {
  const { t } = useTranslation('access');
  const resource = section === 'resources' ? snapshot.resources.find((entry) => entry.id === id) : undefined;
  const member = section === 'members' ? snapshot.members.find((entry) => entry.id === id) : undefined;
  const role = section === 'roles' ? snapshot.roles.find((entry) => entry.id === id) : undefined;
  const name = role ? roleName(role, t) : resource && capability ? capabilityName(capability, t) : (resource ?? member)?.name;
  if (name === undefined) return null;
  const owner = resource ? subjectName({ kind: 'member', id: resource.ownerId }, snapshot, t) : undefined;
  const grants = resource ? snapshot.grants.filter((grant) => grant.resourceId === resource.id).map((grant) => ({ grant, name: subjectName(grant.subject, snapshot, t) })) : [];
  const relatedResources = member ? snapshot.resources.map((entry) => ({ resource: entry, reasons: memberAccess(entry, member, snapshot, t) })).filter((entry) => entry.reasons.length) : [];
  const roleMembers = role ? snapshot.members.filter((entry) => entry.roleIds.includes(role.id)) : [];
  const roleGrants = role ? snapshot.grants.filter((grant) => grant.subject.kind === 'role' && grant.subject.id === role.id) : [];
  const roleResources = role ? snapshot.resources.filter((entry) => roleGrants.some((grant) => grant.resourceId === entry.id)) : [];
  const confirm = (change: AccessChange, title: string, message: string, label: string) => onConfirm({ change, title, message, label, revision: snapshot.revision });
  return <aside className="access-detail" aria-label={t(`details.${section}`)}>
    <div className="access-detail-top"><span>{t(`details.${section}`)}</span><Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label={t('close')}><X aria-hidden="true" className="h-4 w-4" /></Button></div>
    <div className="access-detail-identity"><h2>{name}</h2>{resource && <AccessStatus state={resource.state} />}{member && <AccessStatus state={member.enabled ? 'enabled' : 'disabled'} />}</div>
    {resource && <>
      {capability?.presentation?.kind === 'agent' && <p className="access-note">{t('interop.agentNote')}</p>}
      <dl className="access-facts"><div><dt>{t('source')}</dt><dd>{resource.host.name}</dd></div><div><dt>{t('resourceId')}</dt><dd className="select-text">{resource.id}</dd></div><div><dt>{t('owner')}</dt><dd>{owner}</dd></div></dl>
      <div className="access-detail-heading"><h3>{t('allowedAccess')}</h3><Button type="button" variant="link" size="sm" disabled={disabled} onClick={() => onForm({ kind: 'grant', snapshot, resource })}><Plus aria-hidden="true" className="h-3.5 w-3.5" />{t('grantAccess')}</Button></div>
      <div className="access-grant"><span className="access-grant-icon"><UserRound aria-hidden="true" /></span><strong>{owner}</strong><span className="access-badge">{t('owner')}</span></div>
      {grants.map(({ grant, name }) => <div className="access-grant" key={grant.id}>
        <span className="access-grant-icon">{grant.subject.kind === 'role' ? <Users aria-hidden="true" /> : <UserRound aria-hidden="true" />}</span><strong>{name}</strong><span className="access-badge">{t(grant.subject.kind)}</span>
        <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={t('revokeNamed', { name })} onClick={() => confirm({ kind: 'grant.revoke', id: grant.id }, t('revokeTitle'), t('revokeMessage', { name, resource: resource.name }) + ' ' + t('otherGrantsRemain'), t('revoke'))}><X aria-hidden="true" className="h-3.5 w-3.5" /></Button>
      </div>)}
      <p className="access-note access-inline"><Lock aria-hidden="true" className="h-3.5 w-3.5" />{t('defaultDeny')}</p>
      <div className="access-detail-actions flex-wrap">
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => confirm({ kind: 'resource.state', id: resource.id, state: resource.state === 'paused' ? 'active' : 'paused' }, t(resource.state === 'paused' ? 'resumeResource' : 'pauseResource'), t(resource.state === 'paused' ? 'resumeMessage' : 'pauseMessage', { name: resource.name }), t(resource.state === 'paused' ? 'resumeResource' : 'pauseResource'))}>{resource.state === 'paused' ? <Play aria-hidden="true" className="h-3.5 w-3.5" /> : <Pause aria-hidden="true" className="h-3.5 w-3.5" />}{t(resource.state === 'paused' ? 'resumeResource' : 'pauseResource')}</Button>
        <Button type="button" variant="destructive" size="sm" disabled={disabled} onClick={() => confirm({ kind: 'resource.delete', id: resource.id }, t('unshareResource'), t('unshareMessage', { name: resource.name }), t('unshareResource'))}><Trash2 aria-hidden="true" className="h-3.5 w-3.5" />{t('unshareResource')}</Button>
      </div>
    </>}
    {member && <>
      <div className="access-detail-heading"><h3>{t('assignedRoles')}</h3><Button type="button" variant="link" size="sm" disabled={disabled} onClick={() => onForm({ kind: 'roles', snapshot, member })}>{t('assignRoles')}</Button></div>
      <div className="access-badges">{member.roleIds.map((roleId) => <button type="button" className="access-badge" key={roleId} onClick={() => onSelect('roles', roleId)}>{subjectName({ kind: 'role', id: roleId }, snapshot, t)}</button>)}{!member.roleIds.length && <span className="access-muted">{t('none')}</span>}</div>
      <div className="access-detail-heading"><h3>{t('relatedResources')}</h3></div>
      {!member.enabled && <p className="access-note">{t('disabledAccess')}</p>}
      {relatedResources.map(({ resource: entry, reasons }) => <button type="button" className="access-related" key={entry.id} onClick={() => onSelect('resources', entry.id)}><Layers aria-hidden="true" /><span><strong>{entry.name}</strong><small>{reasons.join(' · ')}</small></span><AccessStatus state={entry.state} /></button>)}
      {!relatedResources.length && <p className="access-note">{t('noGrants')}</p>}
      {member.id !== snapshot.localMemberId && <div className="access-detail-actions access-member-actions"><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => confirm({ kind: 'member.update', id: member.id, name: member.name, enabled: !member.enabled, roleIds: member.roleIds }, t(member.enabled ? 'disableMember' : 'enableMember'), t(member.enabled ? 'disableMessage' : 'enableMessage', { name: member.name }), t(member.enabled ? 'disableMember' : 'enableMember'))}>{t(member.enabled ? 'disableMember' : 'enableMember')}</Button></div>}
    </>}
    {role && <>
      <div className="access-detail-heading"><h3>{t('roleMembers')}</h3></div>
      <div className="access-badges">{roleMembers.map((entry) => <button type="button" className="access-badge" key={entry.id} onClick={() => onSelect('members', entry.id)}>{entry.name}{!entry.enabled && ` (${t('disabled')})`}</button>)}</div>
      {!roleMembers.length && <p className="access-note">{t('noMembers')}</p>}
      <div className="access-detail-heading"><h3>{t('grantedResources')}</h3></div>
      {roleResources.map((entry) => <button type="button" className="access-related" key={entry.id} onClick={() => onSelect('resources', entry.id)}><ShieldCheck aria-hidden="true" /><strong>{entry.name}</strong><AccessStatus state={entry.state} /></button>)}
      {!roleGrants.length && <p className="access-note">{t('noGrants')}</p>}
    </>}
  </aside>;
}
