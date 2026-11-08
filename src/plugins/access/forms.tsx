import { useCallback, useId, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ACCESS_HOST_NAME_MAX_LENGTH, type AccessChange, type AccessMember, type AccessResource, type AccessSnapshot } from '@/types/resource-access';
import type { InterconnectCommand, SharedCapability, SharedFolderOperation } from '@/types/desktop/interconnect';
import { pickLocalDirectory } from '@/lib/local-path-picker';
import { accessError, type AccessUiError } from './client';
import { roleName } from './model';
import { AccessSheet, RequestError } from './ui';
import { CapabilityPicker } from './capability-picker';

export type AccessForm =
  | { kind: 'register' | 'role' | 'host-name'; snapshot: AccessSnapshot }
  | { kind: 'grant'; snapshot: AccessSnapshot; resource: AccessResource }
  | { kind: 'roles'; snapshot: AccessSnapshot; member: AccessMember };

export interface FormProps {
  form: AccessForm;
  busy: boolean;
  blocked: boolean;
  onSubmit: (change: AccessChange, revision: number) => Promise<void>;
  onClose: () => void;
  onRefresh: () => void;
  capabilities: SharedCapability[];
  onShare: (sourceId: string, revision: number) => Promise<void>;
  onShareFolder: (command: Omit<Extract<InterconnectCommand, { kind: 'share.folder' }>, 'kind'>) => Promise<void>;
}

function FormFrame({ title, label, busy, blocked, valid, onSubmit, onClose, onRefresh, children, className }: {
  title: string; label: string; busy: boolean; blocked: boolean; valid: boolean; className?: string;
  onSubmit: () => Promise<void>; onClose: () => void; onRefresh: () => void; children: ReactNode;
}) {
  const { t } = useTranslation('access');
  const [error, setError] = useState<AccessUiError | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy || blocked) return;
    setError(null);
    try { await onSubmit(); onClose(); } catch (cause) { setError(accessError(cause, true)); }
  };
  return <AccessSheet title={title} onClose={onClose} busy={busy} className={className}>
    <form onSubmit={(event) => { void submit(event); }} className="access-form">
      <div className="access-form-body">{children}<RequestError code={error} onRefresh={onRefresh} busy={busy} /></div>
      <footer className="access-sheet-footer"><Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t('cancel')}</Button><Button type="submit" disabled={!valid || busy || blocked}>{busy ? t('saving') : label}</Button></footer>
    </form>
  </AccessSheet>;
}

function RegisterForm({ form, busy, blocked, onClose, onRefresh, capabilities, onShare, onShareFolder }: FormProps) {
  const { t } = useTranslation('access');
  const available = capabilities.filter((capability) => !form.snapshot.resources.some((resource) => resource.sourceId === capability.sourceId));
  const [source, setSource] = useState('');
  const [folderOpen, setFolderOpen] = useState(false);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [operations, setOperations] = useState<SharedFolderOperation[]>(['list', 'read']);
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<AccessUiError | null>(null);
  const disabled = busy || blocked || picking;
  const validName = !!name.trim() && name.length <= 40 && new TextEncoder().encode(name.trim()).length <= 128;
  const valid = folderOpen ? !!path && validName && operations.length > 0 : available.some((capability) => capability.sourceId === source);
  const pickFolder = async () => {
    setPicking(true); setPickerError(null);
    try {
      const selected = await pickLocalDirectory({ title: t('interop.folder.choose'), buttonLabel: t('interop.folder.choose') });
      if (selected) { setPath(selected); if (!name) setName(selected.split(/[\\/]/).filter(Boolean).at(-1) ?? ''); }
    } catch (cause) { setPickerError(accessError(cause)); }
    finally { setPicking(false); }
  };
  return <FormFrame title={t('registerResource')} label={t('registerResource')} className="access-register-sheet" busy={busy || picking} blocked={blocked} valid={valid} onClose={onClose} onRefresh={onRefresh} onSubmit={() => folderOpen ? onShareFolder({ name: name.trim(), path, operations, expectedRevision: form.snapshot.revision }) : onShare(source, form.snapshot.revision)}>
    <div className="access-folder-registration">
      <Button type="button" variant="outline" size="sm" disabled={disabled} aria-expanded={folderOpen} onClick={() => setFolderOpen(!folderOpen)}><FolderOpen aria-hidden="true" className="h-4 w-4" />{t(folderOpen ? 'interop.folder.back' : 'interop.folder.add')}</Button>
      {folderOpen && <fieldset className="access-network-fields" disabled={disabled}>
        <Button type="button" variant="outline" size="sm" onClick={() => { void pickFolder(); }}>{t('interop.folder.choose')}</Button>
        <p className="access-local-path">{path || t('interop.folder.noSelection')}</p>
        <RequestError code={pickerError} />
        <label className="access-field"><span>{t('interop.folder.name')}</span><Input required maxLength={40} value={name} onChange={(event) => setName(event.target.value)} />{name && !validName && <small className="access-error">{t('interop.folder.nameLimit')}</small>}</label>
        <fieldset className="access-fieldset access-folder-operations"><legend>{t('interop.folder.operations')}</legend>{(['list', 'read', 'write'] as const).map((operation) => <label key={operation} className="access-checkbox"><input type="checkbox" checked={operations.includes(operation)} onChange={(event) => setOperations((current) => event.target.checked ? [...current, operation] : current.filter((entry) => entry !== operation))} /><span>{t(`interop.operations.folder.${operation}`)}</span></label>)}</fieldset>
        <p className="access-note">{t('interop.folder.note')}</p>
      </fieldset>}
    </div>
    {!folderOpen && <CapabilityPicker capabilities={available} value={source} disabled={disabled} onChange={setSource} />}
    <p className="access-note access-inline"><Lock aria-hidden="true" className="h-4 w-4" />{t('ownerOnly')}</p>
  </FormFrame>;
}

function GrantForm({ form, busy, blocked, onSubmit, onClose, onRefresh }: FormProps & { form: Extract<AccessForm, { kind: 'grant' }> }) {
  const { t } = useTranslation('access');
  const [kind, setKind] = useState<'role' | 'member'>('role');
  const [subjectId, setSubjectId] = useState('');
  const candidates = kind === 'role' ? form.snapshot.roles.map((role) => ({ id: role.id, name: roleName(role, t) })) : form.snapshot.members.filter((member) => member.enabled && member.id !== form.resource.ownerId);
  const granted = form.snapshot.grants.some((grant) => grant.resourceId === form.resource.id && grant.subject.kind === kind && grant.subject.id === subjectId);
  return <FormFrame title={t('grantAccess')} label={t('grantAccess')} busy={busy} blocked={blocked} valid={!!subjectId && !granted} onClose={onClose} onRefresh={onRefresh} onSubmit={() => onSubmit({ kind: 'grant.create', resourceId: form.resource.id, subject: { kind, id: subjectId } }, form.snapshot.revision)}>
    <div className="access-form-target"><strong>{form.resource.name}</strong><span>{form.resource.host.name}</span></div>
    <div className="access-segment" role="group" aria-label={t('grantTo')}>{(['role', 'member'] as const).map((value) => <Button type="button" key={value} variant={kind === value ? 'secondary' : 'ghost'} aria-pressed={kind === value} onClick={() => { setKind(value); setSubjectId(''); }}>{t(value)}</Button>)}</div>
    <label className="access-field"><span>{t('grantTo')}</span><Select required value={subjectId} onChange={(event) => setSubjectId(event.target.value)}><option value="">{t('selectSubject')}</option>{candidates.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</Select></label>
    {granted && <p className="access-error">{t('alreadyGranted')}</p>}
  </FormFrame>;
}

function RolesForm({ form, busy, blocked, onSubmit, onClose, onRefresh }: FormProps & { form: Extract<AccessForm, { kind: 'roles' }> }) {
  const { t } = useTranslation('access');
  const [ids, setIds] = useState(form.member.roleIds);
  return <FormFrame title={t('assignRoles')} label={t('save')} busy={busy} blocked={blocked} valid onClose={onClose} onRefresh={onRefresh} onSubmit={() => onSubmit({ kind: 'member.update', id: form.member.id, name: form.member.name, enabled: form.member.enabled, roleIds: ids }, form.snapshot.revision)}>
    <p className="access-form-target">{form.member.name}</p>
    <fieldset className="access-fieldset"><legend>{t('assignedRoles')}</legend>{form.snapshot.roles.map((role) => <label className="access-checkbox" key={role.id}><input type="checkbox" checked={ids.includes(role.id)} onChange={(event) => setIds(event.target.checked ? [...ids, role.id] : ids.filter((id) => id !== role.id))} /><span>{roleName(role, t)}</span></label>)}</fieldset>
  </FormFrame>;
}

export function HostNameField({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { t } = useTranslation('access');
  const noteId = useId();
  const change = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value), [onChange]);
  return <label className="access-field"><span>{t('hostName.label')}</span><Input required maxLength={ACCESS_HOST_NAME_MAX_LENGTH} value={value} disabled={disabled} autoComplete="off" aria-describedby={noteId} onChange={change} /><small id={noteId}>{t('hostName.note')}</small></label>;
}

function HostNameForm({ form, busy, blocked, onSubmit, onClose, onRefresh }: FormProps) {
  const { t } = useTranslation('access');
  const [name, setName] = useState(form.snapshot.host.name);
  const valid = !!name.trim() && name.length <= ACCESS_HOST_NAME_MAX_LENGTH;
  return <FormFrame title={t('hostName.edit')} label={t('save')} busy={busy} blocked={blocked} valid={valid} onClose={onClose} onRefresh={onRefresh} onSubmit={() => onSubmit({ kind: 'host.rename', name: name.trim() }, form.snapshot.revision)}>
    <HostNameField value={name} disabled={busy || blocked} onChange={setName} />
  </FormFrame>;
}

function RoleForm({ form, busy, blocked, onSubmit, onClose, onRefresh }: FormProps) {
  const { t } = useTranslation('access');
  const [name, setName] = useState('');
  return <FormFrame title={t('createRole')} label={t('createRole')} busy={busy} blocked={blocked} valid={!!name.trim()} onClose={onClose} onRefresh={onRefresh} onSubmit={() => onSubmit({ kind: 'role.create', name: name.trim() }, form.snapshot.revision)}>
    <label className="access-field"><span>{t('roleName')}</span><Input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
  </FormFrame>;
}

export function AccessForms(props: FormProps) {
  switch (props.form.kind) {
    case 'register': return <RegisterForm {...props} />;
    case 'grant': return <GrantForm {...props} form={props.form} />;
    case 'roles': return <RolesForm {...props} form={props.form} />;
    case 'role': return <RoleForm {...props} />;
    case 'host-name': return <HostNameForm {...props} />;
  }
}
