import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { NetworkConfiguration, NetworkProtocol, NetworkRequest, NetworkSnapshot } from '@/types/desktop/network-access';
import { accessError, commandNetwork, readNetwork, type AccessUiError } from './client';
import { AccessSheet, RequestError } from './ui';

type StunMode = 'default' | 'disabled' | 'custom';
type StunDraft = { mode: StunMode; servers: string };
type NetworkDraft = Omit<NetworkConfiguration, 'listeners' | 'peers' | 'stunServers' | 'stunServersV6' | 'receiveLimitMbps' | 'foreignRelayLimitMbps'> & {
  listeners: string;
  peers: string;
  stunServers: StunDraft;
  stunServersV6: StunDraft;
  receiveLimitMbps: string;
  foreignRelayLimitMbps: string;
};
const PROTOCOLS: readonly NetworkProtocol[] = ['tcp', 'udp', 'ws', 'wss', 'quic', 'wg'];
const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const validLines = (value: string, maxLength: number) => { const entries = lines(value); return entries.length <= 32 && entries.every((entry) => entry.length <= maxLength); };
const stunDraft = (servers: string[] | null): StunDraft => ({ mode: servers === null ? 'default' : servers.length ? 'custom' : 'disabled', servers: servers?.join('\n') ?? '' });
const stunConfig = ({ mode, servers }: StunDraft): string[] | null => mode === 'default' ? null : mode === 'disabled' ? [] : lines(servers);
const networkDraft = (config: NetworkConfiguration): NetworkDraft => ({
  ...config,
  listeners: config.listeners.join('\n'),
  peers: config.peers.join('\n'),
  stunServers: stunDraft(config.stunServers),
  stunServersV6: stunDraft(config.stunServersV6),
  receiveLimitMbps: String(config.receiveLimitMbps),
  foreignRelayLimitMbps: String(config.foreignRelayLimitMbps),
});

export function NetworkSettings({ onClose, onSnapshot }: { onClose: () => void; onSnapshot: (snapshot: NetworkSnapshot) => void }) {
  const { t } = useTranslation('access');
  const [snapshot, setSnapshot] = useState<NetworkSnapshot | null>(null);
  const [draft, setDraft] = useState<NetworkDraft | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<AccessUiError | null>(null);
  const [stopping, setStopping] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const requestBusy = useRef(false);
  const alive = useRef(false);

  const apply = useCallback((next: NetworkSnapshot) => {
    setSnapshot(next);
    onSnapshot(next);
    setDraft(networkDraft(next.config));
    setSecret('');
  }, [onSnapshot]);
  const refresh = useCallback(async () => {
    if (requestBusy.current) return;
    requestBusy.current = true;
    setLoading(true);
    setError(null);
    setSecret('');
    try {
      const next = await readNetwork();
      if (alive.current) { apply(next); setBlocked(false); }
    } catch (cause) { if (alive.current) setError(accessError(cause)); }
    finally { requestBusy.current = false; if (alive.current) setLoading(false); }
  }, [apply]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);

  const command = async (request: NetworkRequest) => {
    if (requestBusy.current || blocked) return;
    requestBusy.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await commandNetwork(request);
      if (alive.current) {
        if (request.kind === 'configure') apply(next);
        else {
          setSnapshot(next);
          onSnapshot(next);
          if (next.revision !== snapshot?.revision) { setError('conflict'); setBlocked(true); }
        }
      }
    } catch (cause) {
      const code = accessError(cause, true);
      if (alive.current) { setError(code); if (code === 'conflict' || code === 'outcome-unknown') setBlocked(true); }
    } finally { requestBusy.current = false; if (alive.current) setBusy(false); }
  };
  const config: NetworkConfiguration | null = draft && {
    ...draft,
    listeners: lines(draft.listeners),
    peers: lines(draft.peers),
    stunServers: stunConfig(draft.stunServers),
    stunServersV6: stunConfig(draft.stunServersV6),
    receiveLimitMbps: Number(draft.receiveLimitMbps),
    foreignRelayLimitMbps: Number(draft.foreignRelayLimitMbps),
  };
  const dirty = !!snapshot && (JSON.stringify(draft) !== JSON.stringify(networkDraft(snapshot.config)) || !!secret);
  const update = <K extends keyof NetworkDraft>(key: K, value: NetworkDraft[K]) => setDraft((current) => current && { ...current, [key]: value });
  const validateList = (input: HTMLTextAreaElement | null, maxLength: number, required = false) => {
    if (!input) return;
    input.setCustomValidity(required && !lines(input.value).length ? t('network.stunRequired') : validLines(input.value, maxLength) ? '' : t('network.listLimit', { maxLength }));
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!snapshot || !config || !dirty || busy || loading || blocked || stopping) return;
    void command({ kind: 'configure', expectedRevision: snapshot.revision, config, ...(secret ? { secret } : {}) });
  };
  const running = snapshot?.phase === 'running' || snapshot?.phase === 'starting';
  const runtime = snapshot?.phase === 'running' ? snapshot.runtime : null;
  const canStart = !!config && !!snapshot && config.enabled && !!config.networkName.trim() && snapshot.hasSecret
    && snapshot.providers.some((provider) => provider.id === config.providerId && provider.available) && !dirty;
  const disabled = busy || loading || blocked || stopping;
  return <AccessSheet title={t('network.title')} onClose={onClose} busy={busy || stopping}>
    <form className="access-form" onSubmit={save} aria-busy={busy || loading} onInvalid={(event) => { setAdvanced(true); let details = (event.target as HTMLElement).closest('details'); while (details) { details.open = true; details = details.parentElement?.closest('details') ?? null; } }}>
      <div className="access-form-body">
        <div className="access-network-status"><span>{t('status')}</span><span role="status">{snapshot ? t(`network.phases.${snapshot.phase}`) : t('loading')}</span><Button type="button" variant="ghost" size="icon" disabled={busy || loading || stopping} aria-label={t('refresh')} onClick={() => { void refresh(); }}><RefreshCw aria-hidden="true" className="h-4 w-4" /></Button></div>
        <p className="access-note mb-6">{t('network.scope')}</p>
        <RequestError code={error ?? snapshot?.error ?? null} onRefresh={() => { void refresh(); }} busy={busy || loading || stopping} />
        {snapshot && <dl className="access-facts">
          <div><dt>{t('network.name')}</dt><dd>{snapshot.config.networkName || t('none')}</dd></div>
          <div><dt>{t('network.peerCount')}</dt><dd>{runtime?.peerCount ?? t('none')}</dd></div>
        </dl>}
        <details className="access-advanced" open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}><summary>{t('network.advanced')}<ChevronRight aria-hidden="true" className="h-4 w-4" /></summary>
        {runtime && <dl className="access-facts">
          <div><dt>{t('network.nodeId')}</dt><dd className="select-text">{runtime.nodeId}</dd></div>
          <div><dt>{t('network.listeners')}</dt><dd>{runtime.listeners.length ? runtime.listeners.map((listener) => <div key={listener}>{listener}</div>) : t('none')}</dd></div>
        </dl>}
        {draft && snapshot && <fieldset className="access-network-fields" disabled={disabled}>
          <label className="access-field"><span>{t('network.component')}</span><Select value={draft.providerId} onChange={(event) => update('providerId', event.target.value)} required><option value="" disabled>{t('network.selectComponent')}</option>{snapshot.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{!provider.available && ` (${t('network.unavailable')})`}</option>)}</Select></label>
          <label className="access-field"><span>{t('network.name')}</span><Input value={draft.networkName} onChange={(event) => update('networkName', event.target.value)} autoComplete="off" required maxLength={128} /></label>
          <label className="access-field"><span>{t('network.secret')}</span><Input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" required={!snapshot.hasSecret} placeholder={snapshot.hasSecret ? t('network.secretUnchanged') : undefined} /></label>
          <label className="access-field"><span>{t('network.peers')}</span><Textarea value={draft.peers} ref={(input) => validateList(input, 512)} onChange={(event) => { update('peers', event.target.value); validateList(event.target, 512); }} rows={3} spellCheck={false} autoCapitalize="none" placeholder={t('network.peersExample')} aria-describedby="access-peers-note" /><small id="access-peers-note">{t('network.peersNote')}</small></label>
          <div className="access-setting"><label htmlFor="access-network-enabled">{t('network.enabled')}</label><Switch id="access-network-enabled" checked={draft.enabled} disabled={disabled} onCheckedChange={(value) => update('enabled', value)} /></div>
          <div className="access-setting"><label htmlFor="access-network-autostart">{t('network.autoStart')}</label><Switch id="access-network-autostart" checked={draft.autoStart} disabled={disabled} onCheckedChange={(value) => update('autoStart', value)} /></div>
          <div className="access-network-advanced" role="group" aria-label={t('network.advanced')}>
            <details className="access-advanced"><summary>{t('network.sections.listening')}<ChevronRight aria-hidden="true" className="h-4 w-4" /></summary>
              <div className="access-network-section">
                <label className="access-field"><span>{t('network.listeners')}</span><Textarea value={draft.listeners} ref={(input) => validateList(input, 512)} onChange={(event) => { update('listeners', event.target.value); validateList(event.target, 512); }} rows={3} spellCheck={false} autoCapitalize="none" placeholder={t('network.listenersExample')} aria-describedby="access-listeners-note" /><small id="access-listeners-note">{t('network.listenersNote')}</small></label>
              </div>
            </details>
            <details className="access-advanced"><summary>{t('network.sections.connection')}<ChevronRight aria-hidden="true" className="h-4 w-4" /></summary>
              <div className="access-network-section">
                <label className="access-field"><span>{t('network.defaultProtocol')}</span><Select value={draft.defaultProtocol} onChange={(event) => update('defaultProtocol', event.target.value as NetworkProtocol)}>{PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{t(`network.protocols.${protocol}`)}</option>)}</Select></label>
                {(['p2p', 'tcpHolePunching', 'udpHolePunching', 'upnp', 'latencyFirst'] as const).map((key) => <div className="access-setting" key={key}><label htmlFor={`access-network-${key}`}>{t(`network.${key}`)}</label><Switch id={`access-network-${key}`} checked={draft[key]} disabled={disabled} onCheckedChange={(value) => update(key, value)} /></div>)}
                <div className="access-network-stun">
                  {(['stunServers', 'stunServersV6'] as const).map((key) => <div className="access-field" key={key}>
                    <label htmlFor={`access-network-${key}`}>{t(`network.${key}`)}</label>
                    <Select id={`access-network-${key}`} value={draft[key].mode} onChange={(event) => update(key, { ...draft[key], mode: event.target.value as StunMode })}>
                      {(['default', 'disabled', 'custom'] as const).map((mode) => <option key={mode} value={mode}>{t(`network.stunModes.${mode}`)}</option>)}
                    </Select>
                    {draft[key].mode === 'custom' && <><Textarea value={draft[key].servers} ref={(input) => validateList(input, 255, true)} onChange={(event) => { update(key, { ...draft[key], servers: event.target.value }); validateList(event.target, 255, true); }} rows={3} spellCheck={false} autoCapitalize="none" required aria-label={t('network.stunAddresses', { name: t(`network.${key}`) })} aria-describedby={`access-network-${key}-note`} /><small id={`access-network-${key}-note`}>{t('network.stunServersNote')}</small></>}
                  </div>)}
                </div>
              </div>
            </details>
            <details className="access-advanced"><summary>{t('network.sections.relay')}<ChevronRight aria-hidden="true" className="h-4 w-4" /></summary>
              <div className="access-network-section">
                <label className="access-field"><span>{t('network.receiveLimitMbps')}</span><Input type="number" min={0} max={1000000} step={1} required value={draft.receiveLimitMbps} onChange={(event) => update('receiveLimitMbps', event.target.value)} aria-describedby="access-receive-limit-note" /><small id="access-receive-limit-note">{t('network.limitNote')}</small></label>
                <div className="access-setting"><label htmlFor="access-network-foreign-relay">{t('network.foreignNetworkRelay')}</label><Switch id="access-network-foreign-relay" checked={draft.foreignNetworkRelay} disabled={disabled} aria-describedby="access-foreign-relay-note" onCheckedChange={(value) => update('foreignNetworkRelay', value)} /></div>
                <p className="access-note access-network-relay-note" id="access-foreign-relay-note">{t('network.foreignNetworkRelayNote')}</p>
                <label className="access-field"><span>{t('network.relayNetworkWhitelist')}</span><Input value={draft.relayNetworkWhitelist} onChange={(event) => update('relayNetworkWhitelist', event.target.value)} autoComplete="off" maxLength={512} spellCheck={false} aria-describedby="access-relay-whitelist-note" /><small id="access-relay-whitelist-note">{t('network.relayNetworkWhitelistNote')}</small></label>
                <label className="access-field"><span>{t('network.foreignRelayLimitMbps')}</span><Input type="number" min={0} max={1000000} step={1} required value={draft.foreignRelayLimitMbps} onChange={(event) => update('foreignRelayLimitMbps', event.target.value)} aria-describedby="access-foreign-limit-note" /><small id="access-foreign-limit-note">{t('network.limitNote')}</small></label>
              </div>
            </details>
          </div>
          <div className="access-network-control"><Button type="button" variant="outline" disabled={disabled || (!running && !canStart)} onClick={() => running ? setStopping(true) : void command({ kind: 'start' })}>{t(running ? 'network.stop' : 'network.start')}</Button>{dirty && <span className="access-note">{t('network.saveFirst')}</span>}</div>
        </fieldset>}
        </details>
      </div>
      <footer className="access-sheet-footer"><Button type="button" variant="outline" onClick={onClose} disabled={busy || stopping}>{t('close')}</Button>{advanced && <Button type="submit" disabled={disabled || !dirty}>{busy ? t('saving') : t('save')}</Button>}</footer>
    </form>
    <ConfirmDialog open={stopping} title={t('network.stop')} message={t('network.stopMessage')} confirmLabel={t('network.stop')} cancelLabel={t('cancel')} variant="destructive" onCancel={() => setStopping(false)} onConfirm={async () => { await command({ kind: 'stop' }); setStopping(false); }} />
  </AccessSheet>;
}
