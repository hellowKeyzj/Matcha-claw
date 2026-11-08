import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ACCESS_HOST_NAME_MAX_LENGTH } from '@/types/resource-access';
import type { ConnectionPreview } from '@/types/desktop/interconnect';
import { accessError, previewConnection, type AccessUiError } from './client';
import { AccessSheet, RequestError } from './ui';
import { HostNameField } from './forms';

export function PairingSheet({ kind, hostName, revision, busy, blocked, onInvite, onConnect, onClose, onRefresh }: {
  kind: 'invite' | 'connect'; hostName: string; revision: number; busy: boolean; blocked: boolean;
  onInvite: (name: string, maxUses: number, hostName: string, revision: number) => Promise<{ invitation: string }>;
  onConnect: (invitation: string, hostName: string, revision: number, preview: ConnectionPreview) => Promise<void>; onClose: () => void; onRefresh: () => void;
}) {
  const { t } = useTranslation('access');
  const [draft, setDraft] = useState('');
  const [localDisplayName, setLocalDisplayName] = useState(hostName);
  const [maxUses, setMaxUses] = useState('10');
  const [invitation, setInvitation] = useState('');
  const [preview, setPreview] = useState<{ connection: ConnectionPreview; invitation: string; hostName: string; revision: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<AccessUiError | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const submitting = useRef(false);
  const uses = Number(maxUses);
  const locked = busy || previewing || !!preview;
  const valid = !!localDisplayName.trim() && localDisplayName.length <= ACCESS_HOST_NAME_MAX_LENGTH && !!draft.trim() && (kind !== 'invite' || (Number.isInteger(uses) && uses >= 1 && uses <= 128));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!event.currentTarget.checkValidity() || !valid || locked || blocked || submitting.current) return;
    submitting.current = true;
    setError(null);
    if (kind === 'connect') setPreviewing(true);
    try {
      if (kind === 'invite') setInvitation((await onInvite(draft.trim(), uses, localDisplayName.trim(), revision)).invitation);
      else {
        const code = draft.trim();
        const name = localDisplayName.trim();
        const connection = await previewConnection(code);
        setPreview({ connection, invitation: code, hostName: name, revision });
      }
    } catch (cause) {
      const code = accessError(cause, kind === 'invite');
      setError(kind === 'connect' && code === 'outcome-unknown' ? 'unavailable' : code);
    } finally { submitting.current = false; setPreviewing(false); }
  };
  const connect = async () => {
    if (!preview || busy || blocked || submitting.current) return;
    submitting.current = true;
    setError(null);
    try { await onConnect(preview.invitation, preview.hostName, preview.revision, preview.connection); onClose(); }
    catch (cause) { setError(accessError(cause, true)); }
    finally { submitting.current = false; setPreview(null); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(invitation); setCopied(true); setCopyFailed(false); }
    catch { setCopyFailed(true); }
  };
  return <AccessSheet title={t(`interop.${kind}`)} onClose={onClose} busy={locked}>
    <form className="access-form" onSubmit={(event) => { void submit(event); }} aria-busy={busy || previewing}>
      <div className="access-form-body">
        {invitation ? <>
          <label className="access-field"><span>{t('interop.invitation')}</span><Textarea readOnly value={invitation} autoComplete="off" spellCheck={false} /></label>
          <Button type="button" variant="outline" size="sm" onClick={() => { void copy(); }}><Copy aria-hidden="true" className="h-4 w-4" />{t(copied ? 'copied' : 'interop.copyInvitation')}</Button>
          {copyFailed && <p className="access-error" role="alert">{t('interop.copyFailed')}</p>}
          <p className="access-note">{t('interop.invitationNote')}</p>
          <label className="access-checkbox"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} /><span>{t('interop.invitationSaved')}</span></label>
        </> : <>
          <HostNameField value={localDisplayName} disabled={locked || blocked} onChange={(value) => { setLocalDisplayName(value); setPreview(null); }} />
          <label className="access-field"><span>{t(kind === 'invite' ? 'interop.invitationName' : 'interop.invitation')}</span>{kind === 'invite'
            ? <Input required maxLength={80} value={draft} disabled={locked || blocked} autoComplete="off" aria-describedby="access-invitation-name-note" onChange={(event) => setDraft(event.target.value)} />
            : <Textarea required value={draft} disabled={locked || blocked} autoComplete="off" spellCheck={false} onChange={(event) => { setDraft(event.target.value); setPreview(null); }} />}{kind === 'invite' && <small id="access-invitation-name-note">{t('interop.invitationNameNote')}</small>}</label>
          {kind === 'invite' && <label className="access-field"><span>{t('interop.maxUses')}</span><Input type="number" required min={1} max={128} step={1} value={maxUses} disabled={locked || blocked} aria-describedby="access-invitation-limit-note" onChange={(event) => setMaxUses(event.target.value)} /><small id="access-invitation-limit-note">{t('interop.maxUsesNote')}</small></label>}
          <p className="access-note">{t(kind === 'invite' ? 'interop.inviteNote' : 'interop.connectNote')}</p>
        </>}
        <RequestError code={error} busy={locked} onRefresh={() => { setPreview(null); setError(null); onRefresh(); }} />
      </div>
      <footer className="access-sheet-footer"><Button type="button" variant="outline" disabled={locked || (!!invitation && !saved)} onClick={onClose}>{t(invitation ? 'close' : 'cancel')}</Button>{!invitation && <Button type="submit" disabled={locked || blocked || !valid}>{t(busy ? 'saving' : previewing ? 'loading' : `interop.${kind}`)}</Button>}</footer>
    </form>
    <ConfirmDialog open={!!preview} title={t(preview?.connection.alreadyPaired ? 'interop.paired' : preview?.connection.replaceNetwork ? 'interop.switchNetwork' : 'interop.confirmConnection')} message={preview ? t(preview.connection.alreadyPaired ? 'interop.alreadyPairedMessage' : preview.connection.replaceNetwork ? 'interop.switchNetworkMessage' : 'interop.confirmConnectionMessage', { name: preview.connection.hostName, network: preview.connection.networkName, currentNetwork: preview.connection.currentNetworkName }) : ''} confirmLabel={t(preview?.connection.alreadyPaired ? 'interop.keepPairing' : preview?.connection.replaceNetwork ? 'interop.switchAndConnect' : 'interop.connect')} cancelLabel={t('cancel')} variant={!preview?.connection.alreadyPaired && preview?.connection.replaceNetwork ? 'destructive' : 'default'} onCancel={() => setPreview(null)} onConfirm={connect} />
  </AccessSheet>;
}
