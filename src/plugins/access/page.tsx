import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Laptop, Layers, Network, Pencil, Plus, RefreshCw, Search, Settings2, ShieldCheck, Users, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { AccessChange, AccessSnapshot } from '@/types/resource-access';
import type { ClientInvitation, ConnectionPreview, InterconnectSnapshot, PairedClient, RemoteCapability } from '@/types/desktop/interconnect';
import type { NetworkSnapshot } from '@/types/desktop/network-access';
import { AccessRequestError, accessError, commandAccess, connectClient, disconnectClient, discoverCapabilities, inviteClient, readAccess, readInterconnect, readNetwork, refreshClients, shareCapability, shareFolder, stopInvitation, type AccessUiError } from './client';
import { AccessDetail, type AccessConfirmation } from './detail';
import { AccessForms, type AccessForm } from './forms';
import { capabilityName, capabilityOperation, groupCapabilities, roleName, subjectName, type AccessSection } from './model';
import { NetworkSettings } from './network';
import { CapabilityDetail } from './capability';
import { PairingSheet } from './pairing';
import { InvitationList } from './invitations';
import { AccessStatus, RequestError } from './ui';
import './style.css';

type Section = AccessSection | 'available' | 'clients';
const SECTIONS = [{ id: 'available', icon: Zap }, { id: 'resources', icon: Layers }, { id: 'clients', icon: Laptop }] as const;
const MANAGEMENT = [{ id: 'members', icon: Users }, { id: 'roles', icon: ShieldCheck }] as const;

export default function AccessPage() {
  const { t } = useTranslation('access');
  const [snapshot, setSnapshot] = useState<AccessSnapshot | null>(null);
  const [interconnect, setInterconnect] = useState<InterconnectSnapshot | null>(null);
  const [network, setNetwork] = useState<NetworkSnapshot | null>(null);
  const [section, setSection] = useState<Section>('available');
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<AccessUiError | null>(null);
  const [form, setForm] = useState<AccessForm | null>(null);
  const [confirmation, setConfirmation] = useState<AccessConfirmation | null>(null);
  const [disconnecting, setDisconnecting] = useState<PairedClient | null>(null);
  const [stoppingInvitation, setStoppingInvitation] = useState<ClientInvitation | null>(null);
  const [pairing, setPairing] = useState<'invite' | 'connect' | null>(null);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [directory, setDirectory] = useState<RemoteCapability[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<AccessUiError | null>(null);
  const [discoveryVersion, setDiscoveryVersion] = useState(0);
  const requestBusy = useRef(false);
  const alive = useRef(false);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);

  const syncSnapshots = useCallback(async () => {
    const [access, peers, nodes] = await Promise.allSettled([readAccess(), readInterconnect(), readNetwork()]);
    if (!alive.current) return false;
    if (access.status === 'fulfilled') { setSnapshot(access.value); setForm((current) => current?.kind === 'host-name' ? { ...current, snapshot: access.value } : current); }
    if (peers.status === 'fulfilled') setInterconnect(peers.value);
    if (nodes.status === 'fulfilled') setNetwork(nodes.value);
    const failed = [access, peers, nodes].find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') { setError(accessError(failed.reason)); setBlocked(true); return false; }
    setDiscoveryVersion((value) => value + 1);
    return true;
  }, []);
  const refresh = useCallback(async (syncClients = false) => {
    if (requestBusy.current) return;
    requestBusy.current = true;
    setLoading(true); setForm((current) => current?.kind === 'host-name' ? current : null); setConfirmation(null); setStoppingInvitation(null); setError(null);
    try {
      if (syncClients) {
        const peers = await refreshClients();
        if (alive.current) setInterconnect(peers);
      }
      if (await syncSnapshots() && alive.current) setBlocked(false);
    } catch (cause) { if (alive.current) setError(accessError(cause)); }
    finally { requestBusy.current = false; if (alive.current) setLoading(false); }
  }, [syncSnapshots]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);
  useEffect(() => {
    let current = true;
    setDirectory(null); setDiscoveryError(null);
    if (!clientId || !interconnect?.clients.some((client) => client.id === clientId && client.phase === 'paired')) { setDiscovering(false); return; }
    setDiscovering(true);
    void discoverCapabilities(clientId).then((result) => { if (current) setDirectory(result.capabilities); })
      .catch((cause) => { if (current) setDiscoveryError(accessError(cause)); })
      .finally(() => { if (current) setDiscovering(false); });
    return () => { current = false; };
  }, [clientId, discoveryVersion, interconnect]);

  const mutate = async <T,>(operation: () => Promise<T>): Promise<T> => {
    if (requestBusy.current || blocked || networkOpen) throw new AccessRequestError('conflict');
    requestBusy.current = true; setBusy(true); setError(null);
    try { return await operation(); }
    catch (cause) {
      const code = accessError(cause, true);
      if (alive.current) { setError(code); if (code === 'conflict' || code === 'outcome-unknown') setBlocked(true); }
      throw cause;
    } finally { requestBusy.current = false; if (alive.current) setBusy(false); }
  };
  const renameHost = async (hostName: string, revision: number) => {
    if (!snapshot) throw new AccessRequestError('conflict');
    const name = hostName.trim();
    if (name === snapshot.host.name) return;
    try {
      const next = await commandAccess({ expectedRevision: revision, change: { kind: 'host.rename', name } });
      if (alive.current) setSnapshot(next);
    } finally { await syncSnapshots(); }
  };
  const syncCapabilities = async () => {
    try { const peers = await readInterconnect(); if (alive.current) setInterconnect(peers); }
    catch (cause) { if (alive.current) { setInterconnect((current) => current ? { ...current, capabilities: [] } : current); setError(accessError(cause)); setBlocked(true); } }
  };
  const updateAccess = (change: AccessChange, revision: number) => mutate(async () => {
    if (change.kind === 'host.rename') { await renameHost(change.name, revision); return; }
    const next = await commandAccess({ expectedRevision: revision, change });
    if (alive.current) {
      setSnapshot(next);
      if (change.kind === 'resource.delete') {
        setSelected((id) => id === change.id ? null : id);
        await syncCapabilities();
      }
    }
  });
  const syncMembers = async () => {
    try { const next = await readAccess(); if (alive.current) setSnapshot(next); }
    catch (cause) { if (alive.current) { setError(accessError(cause)); setBlocked(true); } }
  };
  const invite = (name: string, maxUses: number, hostName: string, revision: number) => mutate(async () => {
    setNetworkOpen(false);
    try { return await inviteClient(name, maxUses, hostName, revision); }
    finally { await syncSnapshots(); }
  });
  const connect = (invitation: string, hostName: string, revision: number, preview: ConnectionPreview) => mutate(async () => {
    setNetworkOpen(false);
    try {
      const next = await connectClient({ invitation, hostName, expectedRevision: revision, expectedNetworkRevision: preview.networkRevision, replaceNetwork: preview.replaceNetwork });
      if (alive.current) setInterconnect(next);
    } finally { await syncSnapshots(); }
  });
  const share = (sourceId: string, revision: number) => mutate(async () => {
    const next = await shareCapability(sourceId, revision);
    if (alive.current) setSnapshot(next);
    await syncCapabilities();
  });
  const registerFolder = (command: Parameters<typeof shareFolder>[0]) => mutate(async () => {
    const next = await shareFolder(command);
    if (alive.current) setSnapshot(next);
    await syncCapabilities();
  });
  const select = (next: Section, id: string | null) => { setSection(next); setSelected(id); setQuery(''); };
  const closeDetail = () => { setSelected(null); detailTrigger.current?.focus(); };
  const disabled = busy || loading || blocked || networkOpen;
  const editHostName = useCallback(() => { if (snapshot) setForm({ kind: 'host-name', snapshot }); }, [snapshot]);
  const refreshPage = useCallback(() => { void refresh(section === 'clients'); }, [refresh, section]);
  const search = query.trim().toLocaleLowerCase();
  const title = (id: Section) => t(id === 'resources' || id === 'available' || id === 'clients' ? `interop.${id}` : id);
  const count = (id: Section) => id === 'available' ? directory?.length : id === 'clients' ? interconnect?.clients.length : snapshot?.[id].length;
  const pairedClients = interconnect?.clients.filter((client) => client.phase === 'paired') ?? [];
  const pairedClient = pairedClients.find((client) => client.id === clientId);
  const selectedClient = section === 'clients' ? interconnect?.clients.find((client) => client.id === selected) : undefined;
  const selectedMember = snapshot?.members.find((member) => member.id === selectedClient?.memberId);
  const selectedCapability = section === 'available' ? directory?.find((capability) => capability.resourceId === selected) : undefined;
  const row = (id: string, name: string, Icon: typeof Layers, cells: ReactNode, description?: string) => <tr key={id} className={selected === id ? 'is-selected' : ''} onClick={(event) => { detailTrigger.current = event.currentTarget.querySelector('button'); setSelected(id); }}>
    <td><button type="button" className="access-entity-button" aria-expanded={selected === id} onClick={(event) => { detailTrigger.current = event.currentTarget; setSelected(id); }}><span className="access-icon-tile"><Icon aria-hidden="true" /></span><span className="access-entity-label"><strong>{name}</strong>{description && <small>{description}</small>}</span><ChevronRight aria-hidden="true" className="access-row-chevron" /></button></td>{cells}
  </tr>;
  let rows: ReactNode[] = [];
  switch (section) {
    case 'resources': {
      const resources = snapshot?.resources.map((resource) => {
        const capability = interconnect?.capabilities.find((entry) => entry.sourceId === resource.sourceId);
        return { resource, capability, sourceId: resource.sourceId, presentation: capability?.presentation };
      }).filter(({ resource, capability }) => `${resource.name} ${resource.host.name} ${capability ? capabilityName(capability, t) : ''}`.toLocaleLowerCase().includes(search)) ?? [];
      rows = groupCapabilities(resources).flatMap((group) => [
        ...(group[0].presentation ? [<tr key={`group:${group[0].sourceId}`} className="access-resource-group"><th scope="rowgroup" colSpan={4}><strong>{group[0].presentation.targetName}</strong><small>{t(`interop.kinds.${group[0].presentation.kind}`)}</small></th></tr>] : []),
        ...group.map(({ resource, capability }) => {
          const subjects = snapshot!.grants.filter((grant) => grant.resourceId === resource.id).map((grant) => subjectName(grant.subject, snapshot!, t));
          return row(resource.id, capability ? capabilityOperation(capability, t) : resource.name, Layers, <><td className="access-muted">{resource.host.name}</td><td className="access-muted">{subjects.length ? <span title={subjects.join(', ')}>{subjects[0]}{subjects.length > 1 && ` +${subjects.length - 1}`}</span> : t('ownerOnlyShort')}</td><td><AccessStatus state={resource.state} /></td></>, capability?.description);
        }),
      ]);
      break;
    }
    case 'members':
      rows = snapshot?.members.filter((member) => member.name.toLocaleLowerCase().includes(search)).map((member) => row(member.id, member.name, Users, <><td className="access-muted">{member.roleIds.map((id) => subjectName({ kind: 'role', id }, snapshot, t)).join(' · ') || t('none')}</td><td><AccessStatus state={member.enabled ? 'enabled' : 'disabled'} /></td></>)) ?? [];
      break;
    case 'roles':
      rows = snapshot?.roles.flatMap((role) => {
        const name = roleName(role, t);
        return name.toLocaleLowerCase().includes(search) ? [row(role.id, name, ShieldCheck, <><td className="access-muted">{t('memberCount', { count: snapshot.members.filter((member) => member.roleIds.includes(role.id)).length })}</td><td className="access-muted">{t('resourceCount', { count: snapshot.grants.filter((grant) => grant.subject.kind === 'role' && grant.subject.id === role.id).length })}</td></>)] : [];
      }) ?? [];
      break;
    case 'clients':
      rows = interconnect?.clients.filter((client) => client.name.toLocaleLowerCase().includes(search)).map((client) => row(client.id, client.name, Laptop, <><td className="access-muted">{snapshot?.members.find((member) => member.id === client.memberId)?.name ?? t('none')}</td><td><span className="access-badge">{t(`interop.${client.phase}`)}</span></td></>)) ?? [];
      break;
    case 'available':
      rows = directory?.filter((capability) => `${capability.name} ${capability.description} ${capabilityName(capability, t)}`.toLocaleLowerCase().includes(search)).map((capability) => row(capability.resourceId, capabilityName(capability, t), Zap, <td className="access-muted">{pairedClient?.name}</td>, capability.description)) ?? [];
      break;
  }
  const columns = section === 'resources' ? ['resource', 'source', 'allowedAccess', 'status'] : section === 'members' ? ['memberName', 'assignedRoles', 'status'] : section === 'roles' ? ['roleName', 'roleMembers', 'grantedResources'] : section === 'clients' ? ['interop.clientName', 'member', 'status'] : ['interop.capability', 'interop.clientName'];
  const nav = ({ id, icon: Icon }: typeof SECTIONS[number] | typeof MANAGEMENT[number]) => <button type="button" key={id} className={section === id ? 'is-selected' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => select(id, null)}><Icon aria-hidden="true" /><span>{title(id)}</span>{count(id) !== undefined && <small>{count(id)}</small>}</button>;
  return <div className="access-page">
    <aside className="access-sidebar">
      <div className="access-sidebar-label">{t('title')}</div>
      {snapshot && <Button type="button" variant="ghost" className="access-host" disabled={disabled} aria-label={t('hostName.editNamed', { name: snapshot.host.name })} title={snapshot.host.name} onClick={editHostName}><strong>{snapshot.host.name}</strong><Pencil aria-hidden="true" /></Button>}
      <nav className="access-nav" aria-label={t('navigation')}>{SECTIONS.map(nav)}<span className="access-management-label">{t('interop.management')}</span>{MANAGEMENT.map(nav)}</nav>
      <div className="access-network-summary" aria-label={t('network.title')}>
        <Network aria-hidden="true" />
        <div className="access-network-copy">
          <strong>{network?.config.networkName || t('none')}</strong>
          <div className="access-network-meta" role="status">
            <span className="access-network-phase" data-phase={network?.phase}><i aria-hidden="true" />{network ? t(`network.phases.${network.phase}`) : t('loading')}</span>
            {network?.runtime && <span className="access-network-peers" title={t('network.peerCount')}>{t('network.nodes', { count: network.runtime.peerCount })}</span>}
          </div>
        </div>
      </div>
      <button type="button" className="access-network-link" disabled={disabled || !!pairing || !!form || !!confirmation || !!disconnecting || !!stoppingInvitation} onClick={() => setNetworkOpen(true)}><Settings2 aria-hidden="true" />{t('network.advanced')}<ChevronRight aria-hidden="true" className="access-network-chevron" /></button>
    </aside>
    <main className="access-workspace">
      <header className="access-page-header"><div className="access-heading"><h1>{title(section)}</h1>{count(section) !== undefined && <span className="access-badge">{count(section)}</span>}</div><div className="access-header-actions">
        <Button type="button" variant="ghost" size="icon" disabled={busy || loading || networkOpen} aria-label={t('refresh')} onClick={refreshPage}><RefreshCw aria-hidden="true" className="h-4 w-4" /></Button>
        {section === 'clients' ? <><Button type="button" size="sm" variant="outline" disabled={disabled || !interconnect} onClick={() => setPairing('connect')}>{t('interop.connect')}</Button><Button type="button" size="sm" disabled={disabled || !interconnect} onClick={() => setPairing('invite')}><Plus aria-hidden="true" className="h-4 w-4" />{t('interop.invite')}</Button></> : (section === 'resources' || section === 'roles') && <Button type="button" size="sm" disabled={!snapshot || disabled || (section === 'resources' && !interconnect)} onClick={() => snapshot && setForm({ kind: section === 'resources' ? 'register' : 'role', snapshot })}><Plus aria-hidden="true" className="h-4 w-4" />{t(section === 'resources' ? 'registerResource' : 'createRole')}</Button>}
      </div></header>
      <RequestError code={error ?? network?.error ?? null} busy={busy || loading || networkOpen} onRefresh={refreshPage} />
      <div className="access-workspace-body">
        <section className="access-inventory" aria-label={title(section)} aria-busy={loading || discovering}>
          <div className="access-toolbar"><label className="access-search"><Search aria-hidden="true" /><Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t(`search.${section}`)} aria-label={t(`search.${section}`)} /></label>
            {section === 'available' && <label className="access-client-filter"><span className="sr-only">{t('interop.chooseClient')}</span><Select value={pairedClient ? clientId : ''} disabled={loading} onChange={(event) => { setClientId(event.target.value); setSelected(null); }}><option value="">{t('interop.chooseClient')}</option>{pairedClients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</Select></label>}
          </div>
          {section === 'available' && <RequestError code={discoveryError} busy={discovering} onRefresh={() => setDiscoveryVersion((value) => value + 1)} />}
          {(loading && !snapshot) || (section === 'available' && discovering) ? <div className="access-loading" role="status"><span className="sr-only">{t('loading')}</span>{[0, 1, 2, 3].map((index) => <div key={index} />)}</div> : <div className="access-table-scroll">{section === 'clients' && interconnect && <InvitationList invitations={interconnect.invitations} disabled={disabled} onStop={setStoppingInvitation} />}<table className="access-table" data-section={section} aria-label={title(section)}><thead><tr>{columns.map((key) => <th key={key} scope="col">{t(key)}</th>)}</tr></thead><tbody>{rows}</tbody></table>{!rows.length && !discoveryError && <div className="access-empty">{t(query ? 'noResults' : section === 'available' ? !pairedClients.length ? 'interop.noClients' : !pairedClient ? 'interop.chooseClient' : 'empty.available' : `empty.${section}`)}{section === 'available' && !pairedClients.length && <Button type="button" variant="link" onClick={() => select('clients', null)}>{t('interop.connect')}</Button>}</div>}</div>}
        </section>
        {snapshot && selected && section !== 'available' && section !== 'clients' && <AccessDetail section={section} id={selected} snapshot={snapshot} disabled={disabled} onClose={closeDetail} onForm={setForm} onConfirm={setConfirmation} onSelect={select} capability={interconnect?.capabilities.find((entry) => entry.sourceId === snapshot.resources.find((resource) => resource.id === selected)?.sourceId)} />}
        {selectedCapability && pairedClient && <CapabilityDetail key={`${clientId}:${selectedCapability.resourceId}`} clientId={clientId} clientName={pairedClient.name} capability={selectedCapability} disabled={disabled} onClose={closeDetail} />}
        {selectedClient && <aside className="access-detail" aria-label={t('interop.clientDetails')}><div className="access-detail-top"><span>{t('interop.clientDetails')}</span><Button type="button" variant="ghost" size="icon" onClick={closeDetail} aria-label={t('close')}><X aria-hidden="true" className="h-4 w-4" /></Button></div><div className="access-detail-identity"><h2>{selectedClient.name}</h2><span className="access-badge">{t(`interop.${selectedClient.phase}`)}</span></div><p className="access-note">{t('interop.pairingNote')}</p>{selectedMember && <><div className="access-detail-heading"><h3>{t('member')}</h3></div><button type="button" className="access-related" onClick={() => select('members', selectedMember.id)}><Users aria-hidden="true" /><strong>{selectedMember.name}</strong><AccessStatus state={selectedMember.enabled ? 'enabled' : 'disabled'} /></button></>}<div className="access-member-actions access-detail-actions">{selectedClient.phase === 'paired' && <Button type="button" variant="outline" size="sm" onClick={() => { setClientId(selectedClient.id); select('available', null); }}>{t('interop.browse')}</Button>}<Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setDisconnecting(selectedClient)}>{t('interop.disconnect')}</Button></div></aside>}
      </div>
    </main>
    {form && <AccessForms form={form} busy={busy || loading} blocked={blocked} onSubmit={updateAccess} onClose={() => setForm(null)} onRefresh={() => { void refresh(); }} capabilities={interconnect?.capabilities ?? []} onShare={share} onShareFolder={registerFolder} />}
    {pairing && snapshot && <PairingSheet kind={pairing} hostName={snapshot.host.name} revision={snapshot.revision} busy={busy || loading} blocked={blocked || networkOpen} onInvite={invite} onConnect={connect} onClose={() => setPairing(null)} onRefresh={() => { void refresh(); }} />}
    <ConfirmDialog open={!!confirmation} title={confirmation?.title ?? ''} message={confirmation?.message ?? ''} confirmLabel={confirmation?.label ?? t('confirm')} cancelLabel={t('cancel')} variant="destructive" onCancel={() => setConfirmation(null)} onConfirm={async () => { if (!confirmation) return; try { await updateAccess(confirmation.change, confirmation.revision); } catch { /* The page owns the actionable error. */ } setConfirmation(null); }} />
    <ConfirmDialog open={!!disconnecting} title={t('interop.disconnect')} message={t('interop.disconnectNote', { name: disconnecting?.name })} confirmLabel={t('interop.disconnect')} cancelLabel={t('cancel')} variant="destructive" onCancel={() => setDisconnecting(null)} onConfirm={async () => { if (!disconnecting) return; try { await mutate(async () => { const next = await disconnectClient(disconnecting.id); if (alive.current) { setInterconnect(next); setSelected(null); } await syncMembers(); }); } catch { /* The page owns the actionable error. */ } setDisconnecting(null); }} />
    <ConfirmDialog open={!!stoppingInvitation} title={t('interop.stopInvitation')} message={t('interop.stopInvitationNote', { name: stoppingInvitation?.name })} confirmLabel={t('interop.stopInvitation')} cancelLabel={t('cancel')} variant="destructive" onCancel={() => setStoppingInvitation(null)} onConfirm={async () => { if (!stoppingInvitation) return; try { await mutate(async () => { const next = await stopInvitation(stoppingInvitation.id); if (alive.current) setInterconnect(next); }); } catch { /* The page owns the actionable error. */ } setStoppingInvitation(null); }} />
    {networkOpen && <NetworkSettings onClose={() => { setNetworkOpen(false); void refresh(); }} onSnapshot={setNetwork} />}
  </div>;
}
