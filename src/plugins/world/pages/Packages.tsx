import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Boxes, Package, Plus, Search, Shield, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWorldStore } from '../store';
import { queryWorld, sameWorld } from '../store/client';
import type { ActivationRequest, ActivationSelection, BindingHead, CompositionSelection, DataflowSelection, ImplementationSelection, InstalledRecord, ProviderSelection, SlotKind } from '@/types/world';
import { DataTable, Empty, Field, Section, selectClass, TextField } from './components';
import { FixedRecord } from './Definitions';
import { PackageManagement, PackageTrustPolicy } from './PackageManagement';
import { useWorldConfirmation } from './WorldConfirmation';

const slots: SlotKind[] = ['connector', 'identity', 'schema', 'resolver', 'projection', 'provenance', 'compiler', 'policy', 'action', 'reconcile', 'abstraction', 'evaluation', 'context', 'agent_bridge', 'storage'];

const hostImportContracts = [
  ['world_read', 'world-read.query'], ['model_generate', 'model.generate'],
  ['state_read', 'state.read'], ['state_write', 'state.write'], ['clock', 'clock.now'], ['log', 'logging.log'],
] as const;
const modes: CompositionSelection['mode'][] = ['single', 'ordered', 'chain', 'typed_dag', 'fan_out'];
const merges: CompositionSelection['merge'][] = ['none', 'ordered_concatenation', 'disjoint_fields', 'require_equal', 'explicit_conflict', 'mandatory_and_deny_overrides'];

export function Packages() {
  const { t } = useTranslation('world');
  const navigate = useNavigate();
  const state = useWorldStore();
  const confirm = useWorldConfirmation();
  const [packages, setPackages] = useState<InstalledRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [slotFilter, setSlotFilter] = useState('');
  const [inspected, setInspected] = useState('');
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [upgrade, setUpgrade] = useState('');
  const [installOpen, setInstallOpen] = useState(false);
  const [trustOpen, setTrustOpen] = useState(false);
  const [nodeId, setNodeId] = useState('');
  const [bindingId, setBindingId] = useState('');
  const [namespace, setNamespace] = useState('');
  const [required, setRequired] = useState(false);
  const [hostImports, setHostImports] = useState<ImplementationSelection['hostImports']>([]);
  const [nodes, setNodes] = useState<ImplementationSelection[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [trustedRoots, setTrustedRoots] = useState<string[]>([]);
  const [edges, setEdges] = useState<ProviderSelection[]>([]);
  const [consumer, setConsumer] = useState('');
  const [consumerPort, setConsumerPort] = useState('');
  const [provider, setProvider] = useState('');
  const [providerPort, setProviderPort] = useState('');
  const [compositions, setCompositions] = useState<CompositionSelection[]>([]);
  const [compositionBinding, setCompositionBinding] = useState('');
  const [mode, setMode] = useState<CompositionSelection['mode'] | ''>('');
  const [merge, setMerge] = useState<CompositionSelection['merge'] | ''>('');
  const [failure, setFailure] = useState<CompositionSelection['failure'] | ''>('');
  const [order, setOrder] = useState<string[]>([]);
  const [wiring, setWiring] = useState<DataflowSelection[]>([]);
  const [output, setOutput] = useState('');
  const [outputPort, setOutputPort] = useState('');
  const [input, setInput] = useState('');
  const [inputPort, setInputPort] = useState('');
  const [channel, setChannel] = useState('');
  const [heads, setHeads] = useState<Array<{ channel: string; expected: BindingHead | null }>>([]);
  const [channels, setChannels] = useState<Record<string, string>>({});
  const [lockId, setLockId] = useState('');
  const [plan, setPlan] = useState<ActivationRequest | null>(null);
  const [planning, setPlanning] = useState(false);
  const currentPlan = useRef({ plan, planning });
  currentPlan.current = { plan, planning };
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const bindingPanel = useRef<HTMLDetailsElement>(null);
  const packageDetails = useRef<HTMLDetailsElement>(null);
  const currentWorld = useRef(state.world);
  currentWorld.current = state.world;
  const revision = useRef(0);
  const world = state.world;
  const bindings = [...new Set(nodes.map(node => node.bindingId))];
  const options = packages.flatMap(record => record.manifest.provides.flatMap(item => {
    const artifact = record.manifest.artifacts.find(artifact => artifact.id === item.artifactId && artifact.kind === 'implementation');
    return artifact ? [{ key: JSON.stringify([record.installId, item.providerId, item.artifactId, item.slot]), record, item, artifact }] : [];
  }));
  const implementation = options.find(option => option.key === selected);
  const term = search.trim().toLocaleLowerCase();
  const visiblePackages = packages.filter(record => (!slotFilter || record.manifest.provides.some(item => item.slot === slotFilter))
    && (!term || [record.manifest.identity.id, record.manifest.identity.publisher, record.manifest.identity.version, record.installId, ...record.manifest.provides.flatMap(item => [item.slot, item.providerId, ...item.contracts.map(contract => contract.id)])].some(value => value.toLocaleLowerCase().includes(term))));
  const inspectedPackage = packages.find(record => record.installId === inspected) ?? visiblePackages[0];
  const baseline = state.description?.editingContext?.activationLock;
  const activeLock = world && baseline && sameWorld(baseline.world, world) ? baseline : null;
  const source = nodes.find(node => node.id === consumer);
  const target = nodes.find(node => node.id === provider);
  const sourceRecord = packages.find(record => record.installId === source?.installId);
  const targetRecord = packages.find(record => record.installId === target?.installId);
  const targetImplementation = targetRecord?.manifest.provides.find(item => item.providerId === target?.providerId && item.artifactId === target.artifactId && item.slot === target.slot);
  const change = () => { revision.current++; setPlan(null); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  useEffect(() => {
    let current = true; setError(''); setLoading(Boolean(world));
    if (world) void queryWorld(world, { kind: 'packages', request: { page: { limit: 100, cursor } } }, 'packages').then(page => {
      if (!current) return;
      if (page.items.some(record => !sameWorld(record.world, world))) throw new Error(t('packages.errors.inventoryWorldMismatch'));
      setPackages(previous => cursor ? [...previous.filter(record => !page.items.some(item => item.installId === record.installId)), ...page.items] : page.items);
      setNextCursor(page.nextCursor ?? null);
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : t('packages.errors.inventoryLoad')); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [world, state.description?.incarnation, state.description?.revision, cursor, t]);
  useEffect(() => {
    change(); setPackages([]); setCursor(null); setNextCursor(null); setSelected(''); setHostImports([]); setInspected(''); setSearch(''); setSlotFilter(''); setNodes([]); setEdges([]); setCompositions([]); setHeads([]); setChannels({}); setRoots([]); setTrustedRoots([]); setPackageFile(null); setUpgrade('');
  }, [world?.tenantId, world?.worldId, state.description?.incarnation]);
  useEffect(() => { change(); setPackages([]); setCursor(null); setNextCursor(null); }, [state.description?.revision]);
  const upload = async (form: HTMLFormElement) => {
    if (!packageFile || state.busy || !world) return;
    const incarnation = state.description?.incarnation;
    setError('');
    try {
      if (!packageFile.size || packageFile.size > 1024 * 1024 * 1024) throw new Error(t('packages.management.fileLimit'));
      const previous = upgrade ? packages.find(record => record.installId === upgrade) : null;
      if (upgrade && !previous) throw new Error(t('packages.management.upgradeMissing'));
      const result = await state.uploadPackage(packageFile, previous ? { installId: previous.installId, expectedRevision: previous.revision } : undefined);
      const latest = useWorldStore.getState();
      if (!result || !mounted.current || !latest.world || !sameWorld(latest.world, world) || latest.description?.incarnation !== incarnation) return;
      form.reset(); setPackageFile(null); setUpgrade('');
      if (result.kind === 'accepted') navigate('/world/settings?tab=operations');
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : t('packages.management.requestFailed')); }
  };
  const readHead = async () => {
    if (!world || !channel.trim()) return;
    const expectedWorld = world; const name = channel.trim(); const version = revision.current;
    try {
      const head = await queryWorld(world, { kind: 'binding_head', request: { channel: name } }, 'binding_head');
      if (!mounted.current || version !== revision.current || !currentWorld.current || !sameWorld(currentWorld.current, expectedWorld)) return;
      if (head && (!sameWorld(head.world, expectedWorld) || head.channel !== name)) throw new Error(t('packages.errors.headMismatch'));
      change(); setHeads(items => [...items.filter(item => item.channel !== name), { channel: name, expected: head }]);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : t('packages.errors.headLoad')); }
  };
  const build = async () => {
    if (!world || planning || state.busy || !lockId.trim() || !nodes.length || !heads.length || !roots.length) return;
    const selection: ActivationSelection = { id: lockId.trim(), nodes, edges, compositions, roots, trustedRoots, channels: bindings.map(bindingId => ({ bindingId, channel: channels[bindingId] ?? '' })), heads };
    const version = revision.current;
    setPlanning(true); setError(''); setPlan(null);
    try {
      const result = await queryWorld(world, { kind: 'activation_plan', request: selection }, 'activation_plan');
      if (!mounted.current || version !== revision.current || !currentWorld.current || !sameWorld(currentWorld.current, world)) return;
      if (!sameWorld(result.graph.world, world) || result.graph.id !== selection.id) throw new Error(t('packages.errors.planMismatch'));
      setPlan(result);
    } catch (error) { if (mounted.current && version === revision.current) setError(error instanceof Error ? error.message : t('packages.errors.planLoad')); }
    finally { if (mounted.current) setPlanning(false); }
  };
  const activate = async () => {
    if (!world || !plan || planning || state.busy) return;
    const request = plan; const version = revision.current;
    const incarnation = state.description?.incarnation; const worldRevision = state.description?.revision;
    if (!await confirm(t('packages.activationConfirm'))) return;
    const latest = useWorldStore.getState();
    if (!mounted.current || version !== revision.current || !currentWorld.current || !sameWorld(currentWorld.current, world)
      || currentPlan.current.plan !== request || currentPlan.current.planning || !latest.world || !sameWorld(latest.world, world)
      || latest.description?.status !== 'ready' || latest.description.incarnation !== incarnation || latest.description.revision !== worldRevision
      || latest.loading || latest.busy || latest.operationBusy || latest.pending || latest.pendingOperation || latest.transferBusy) return;
    void state.command({ kind: 'activate', request }).then(result => { if (result.kind === 'accepted') navigate('/world/settings?tab=operations'); }).catch(() => undefined);
  };
  return <div className="min-w-0 space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-base font-semibold">{t('packages.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('atelier.packages.listHint')}</p></div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" aria-expanded={trustOpen} aria-controls="world-package-trust" onClick={() => setTrustOpen(value => !value)}><Shield className="mr-2 h-4 w-4" aria-hidden="true" />{t('packages.management.trustPolicy')}</Button>
        <Button type="button" size="sm" aria-expanded={installOpen} aria-controls="world-package-install" onClick={() => setInstallOpen(value => !value)}><Plus className="mr-2 h-4 w-4" aria-hidden="true" />{t('atelier.packages.addZip')}</Button>
      </div>
    </header>
    {error && <p className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive" role="alert">{error}</p>}
    <div id="world-package-install" hidden={!installOpen}>
      <section className="world-panel">
        <header className="world-panel-header"><h3 className="text-sm font-semibold">{t('packages.management.installTitle')}</h3></header>
        <form key={JSON.stringify(world)} className="world-panel-body space-y-4" onSubmit={event => { event.preventDefault(); void upload(event.currentTarget); }}>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('packages.management.installNotice')}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('packages.management.packageFile')}><input type="file" accept=".zip,application/zip" required disabled={state.busy} className="max-w-full text-sm" onChange={event => setPackageFile(event.target.files?.[0] ?? null)} /></Field>
            <Field label={t('packages.management.installMode')}><select className={selectClass} disabled={state.busy} value={upgrade} onChange={event => setUpgrade(event.target.value)}><option value="">{t('packages.management.installNew')}</option>{packages.map(record => <option key={record.installId} value={record.installId}>{t('packages.management.upgradeOption', { name: record.manifest.identity.id, version: record.manifest.identity.version })} · {record.installId}</option>)}</select></Field>
          </div>
          <Button type="submit" size="sm" disabled={state.busy || !packageFile}>{t(upgrade ? 'packages.management.submitUpgrade' : 'packages.management.submitInstall')}</Button>
        </form>
      </section>
    </div>
    <div id="world-package-trust" hidden={!trustOpen}><PackageTrustPolicy /></div>
    <section className="world-panel min-w-0" aria-label={t('packages.title')}>
      <div className="world-panel-body flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1"><Field label={t('atelier.packages.search')}><div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" /><Input type="search" className="h-9 pl-9 text-sm" value={search} onChange={event => setSearch(event.target.value)} /></div></Field></div>
        <Field label={t('atelier.packages.slotFilter')}><select className={selectClass} value={slotFilter} onChange={event => setSlotFilter(event.target.value)}><option value="">{t('atelier.packages.allSlots')}</option>{slots.map(slot => <option key={slot} value={slot}>{slot}</option>)}</select></Field>
      </div>
      {loading && <p className="px-5 pb-3 text-sm text-muted-foreground" role="status">{t('packages.loading')}</p>}
      {(visiblePackages.length > 0 || (!loading && !error)) && <DataTable
        columns={[t('packages.plugin'), t('atelier.packages.providedSlots'), t('packages.version'), t('changes.statusLabel'), t('packages.management.title')]}
        rowKeys={visiblePackages.map(record => record.installId)} selectedRowKey={inspectedPackage?.installId}
        onRowSelect={key => { setInspected(key); if (packageDetails.current) { packageDetails.current.open = true; packageDetails.current.scrollIntoView({ block: 'nearest' }); packageDetails.current.focus({ preventScroll: true }); } }}
        rows={visiblePackages.map(record => [
          <div className="flex min-w-0 items-start gap-3"><Package className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0"><p className="break-words font-medium">{record.manifest.identity.id}</p><p className="mt-1 break-words text-xs text-muted-foreground">{record.manifest.identity.publisher}</p></div></div>,
          <span className="text-xs text-muted-foreground">{[...new Set(record.manifest.provides.map(item => item.slot))].join(' / ') || t('atelier.packages.noProvidedSlots')}</span>,
          <span className="font-mono text-xs">{record.manifest.identity.version}</span>,
          <div className="space-y-1"><span className="world-status text-xs">{t('atelier.packages.installed')}</span>{activeLock?.nodes.some(node => node.implementation.installId === record.installId) && <p className="text-xs text-muted-foreground">{t('atelier.packages.currentLockReference')}</p>}</div>,
          <Button type="button" size="sm" variant="ghost" onClick={() => { setInspected(record.installId); if (packageDetails.current) { packageDetails.current.open = true; packageDetails.current.scrollIntoView({ block: 'nearest' }); packageDetails.current.focus({ preventScroll: true }); } }}>{t('packages.details')}</Button>,
        ])} empty={t(packages.length ? 'atelier.packages.noMatches' : 'packages.empty')} />}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--shell-border))] px-5 py-3">
        <p className="text-xs text-muted-foreground">{t('atelier.packages.loadedScope', { shown: visiblePackages.length, total: packages.length })}</p>
        {(cursor || nextCursor) && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={loading || !cursor} onClick={() => setCursor(null)}>{t('packages.firstPage')}</Button><Button size="sm" variant="outline" disabled={loading || !nextCursor} onClick={() => setCursor(nextCursor)}>{t('packages.loadMore')}</Button></div>}
      </footer>
    </section>
    <details ref={packageDetails} tabIndex={-1} className="world-panel min-w-0 scroll-mt-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <summary className="cursor-pointer px-5 py-4 text-sm font-medium">{t('packages.details')}{inspectedPackage && <span className="ml-3 break-all text-xs font-normal text-muted-foreground">{inspectedPackage.manifest.identity.id} · {inspectedPackage.manifest.identity.version}</span>}</summary>
      {inspectedPackage ? <div className="world-panel-body space-y-5 border-t border-[hsl(var(--shell-border))]">
        <p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.packages.manifestNotice')}</p>
        <dl className="grid gap-4 text-xs sm:grid-cols-3"><div><dt className="text-muted-foreground">{t('atelier.packages.publisher')}</dt><dd className="mt-1 break-words">{inspectedPackage.manifest.identity.publisher}</dd></div><div><dt className="text-muted-foreground">{t('atelier.packages.installId')}</dt><dd className="mt-1 break-all font-mono">{inspectedPackage.installId}</dd></div><div><dt className="text-muted-foreground">{t('atelier.packages.runtime')}</dt><dd className="mt-1 break-words">{[...new Set(inspectedPackage.manifest.artifacts.map(artifact => artifact.runtime))].join(' / ') || t('atelier.packages.none')}</dd></div></dl>
        <PackageManagement key={inspectedPackage.installId} record={inspectedPackage} />
        <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('atelier.packages.providedSlots')}</summary><div className="mt-4 grid gap-3 sm:grid-cols-2">{inspectedPackage.manifest.provides.length ? inspectedPackage.manifest.provides.map((item, index) => <div key={index} className="space-y-2 rounded-lg border border-border p-3"><p className="break-words text-sm font-medium">{item.slot}</p><p className="break-words text-xs text-muted-foreground">{item.providerId}<br />{item.artifactId}</p><p className="text-xs text-muted-foreground">{t('atelier.packages.contracts')}</p>{item.contracts.length ? item.contracts.map((contract, position) => <p key={position} className="break-words font-mono text-xs">{contract.id}<span className="block text-muted-foreground">{contract.version}</span></p>) : <p className="text-xs text-muted-foreground">{t('atelier.packages.noContracts')}</p>}</div>) : <p className="text-sm text-muted-foreground">{t('atelier.packages.noProvidedSlots')}</p>}</div></details>
        <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('atelier.packages.requestedAccess')}</summary><div className="mt-4 space-y-3">{inspectedPackage.manifest.requestedAccess.length ? inspectedPackage.manifest.requestedAccess.map((access, index) => <div key={index} className="space-y-2 rounded-lg border border-border p-3 text-xs"><p className="font-medium">{t(`atelier.packages.permissions.${access.kind}`)}</p><FixedRecord value={access} /></div>) : <p className="text-sm text-muted-foreground">{t('atelier.packages.noRequestedAccess')}</p>}</div></details>
        <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('atelier.packages.requiredContracts')}</summary><div className="mt-4">{inspectedPackage.manifest.requires.length ? <FixedRecord value={inspectedPackage.manifest.requires} /> : <p className="text-sm text-muted-foreground">{t('atelier.packages.none')}</p>}</div></details>
        <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('atelier.packages.packageRecord')}</summary><div className="mt-4"><FixedRecord value={inspectedPackage} /></div></details>
      </div> : <Empty>{t('atelier.packages.selectPackage')}</Empty>}
    </details>
    <div className="flex flex-wrap items-center justify-between gap-3 px-1">
      <p className="text-sm text-muted-foreground">{t('packages.installationNotice')}</p>
      <Button type="button" size="sm" variant="ghost" onClick={() => navigate('/world/settings?tab=operations')}>{t('operations.title')}<ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /></Button>
    </div>
    <section className="world-panel">
      <header className="world-panel-header"><div className="min-w-0"><h3 className="text-sm font-semibold">{t('packages.configurationTitle')}</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('atelier.packages.bindingHint')}</p></div><Button type="button" size="sm" variant="outline" onClick={() => { if (bindingPanel.current) { bindingPanel.current.open = true; bindingPanel.current.scrollIntoView({ block: 'start' }); bindingPanel.current.focus({ preventScroll: true }); } }}><Workflow className="mr-2 h-4 w-4" aria-hidden="true" />{t('packages.configure')}</Button></header>
      <details className="world-panel-body"><summary className="cursor-pointer text-sm font-medium">{t('atelier.packages.pipeline')}</summary>
        {activeLock ? <div className="mt-4 space-y-4">
          <p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.packages.pipelineNotice')}</p>
          <p className="break-words font-mono text-xs text-muted-foreground">{activeLock.id}</p>
          {activeLock.nodes.length ? <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {activeLock.nodes.map(node => <li key={node.id} className="min-w-0 rounded-lg border border-border p-3"><div className="flex items-start gap-2"><Boxes className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0"><p className="break-words text-sm font-medium">{node.slot}</p><p className="mt-1 break-words font-mono text-xs text-muted-foreground">{node.id}</p></div></div><p className="mt-3 break-words text-xs text-muted-foreground">{node.providerId}<br />{node.implementation.installId}</p></li>)}
          </ul> : <Empty>{t('packages.emptySelection')}</Empty>}
          <div><h4 className="mb-2 text-xs font-medium text-muted-foreground">{t('atelier.packages.connections')}</h4>{activeLock.edges.length ? <ul className="space-y-2">{activeLock.edges.map((edge, index) => <li key={index} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-xs"><span className="break-all font-mono">{edge.provider} / {edge.providerPort}</span><ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="break-all font-mono">{edge.consumer} / {edge.consumerPort}</span><span className="w-full break-words text-muted-foreground">{edge.contract.id} · {edge.contract.version}</span></li>)}</ul> : <p className="text-sm text-muted-foreground">{t('atelier.packages.noConnections')}</p>}</div>
          {activeLock.compositions.some(composition => composition.wiring.length) && <DataTable columns={[t('packages.output'), t('packages.input')]} rows={activeLock.compositions.flatMap(composition => composition.wiring.map(edge => [`${edge.outputNode} / ${edge.outputPort}`, `${edge.inputNode} / ${edge.inputPort}`]))} />}
          <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('packages.details')}</summary><div className="mt-3"><FixedRecord value={activeLock} /></div></details>
        </div> : <Empty>{t('atelier.packages.pipelineEmpty')}</Empty>}
      </details>
    </section>
    <details ref={bindingPanel} tabIndex={-1} key={JSON.stringify([world?.tenantId, world?.worldId, state.description?.incarnation])} className="world-panel scroll-mt-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <summary className="cursor-pointer px-5 py-4 text-sm font-medium">{t('packages.configure')}</summary>
      <div className="world-panel-body border-t border-[hsl(var(--shell-border))]"><Section title={t('packages.configurationTitle')} description={t('packages.configurationNotice')}>
    <div className="mb-5 space-y-3"><p className="text-xs text-muted-foreground">{t('packages.management.slotCoverage')}</p><div className="grid grid-cols-1 gap-2 sm:grid-cols-3">{slots.map(slot => <div key={slot} className="flex min-w-0 items-start justify-between gap-2 rounded-lg border border-border p-3 text-xs"><span className="break-words font-medium">{slot}</span><span className="text-right text-muted-foreground">{t('packages.management.slotCounts', { installed: options.filter(option => option.item.slot === slot).length, active: activeLock?.nodes.filter(node => node.slot === slot).length ?? 0 })}</span></div>)}</div></div>
    <div className="space-y-5"><fieldset className="grid gap-3 rounded-xl border border-border p-4"><legend className="px-1 text-sm font-medium">{t('packages.nodeLegend')}</legend><Field label={t('packages.implementation')}><select className={selectClass} value={selected} onChange={event => { setSelected(event.target.value); setNamespace(''); setHostImports([]); }}><option value="">{t('packages.selectImplementation')}</option>{options.map(option => <option key={option.key} value={option.key}>{option.record.manifest.identity.id} · {option.record.manifest.identity.version} · {option.item.providerId} · {option.item.artifactId} · {option.item.slot} · {option.record.installId}</option>)}</select></Field>
      <div className="grid gap-3 sm:grid-cols-2"><TextField label={t('packages.nodeId')} value={nodeId} onChange={setNodeId} /><TextField label={t('packages.bindingId')} value={bindingId} onChange={setBindingId} /><Field label={t('packages.stateNamespace')}><select className={selectClass} value={namespace} onChange={event => setNamespace(event.target.value)}><option value="">{t('packages.noStateNamespace')}</option>{implementation?.record.manifest.state.map(item => <option key={item.namespace} value={item.namespace}>{item.namespace}</option>)}</select></Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={required} onChange={event => setRequired(event.target.checked)} />{t('packages.required')}</label></div>
      <fieldset className="space-y-3 border-t border-border pt-4"><legend className="px-1 text-sm font-medium">{t('packages.hostImports.title')}</legend><p className="text-xs text-muted-foreground">{t('packages.hostImports.hint')}</p><div className="grid gap-3 sm:grid-cols-2">{hostImportContracts.map(([kind, contract]) => <label key={kind} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" disabled={!implementation?.record.manifest.requires.some(item => item.id === contract)} checked={hostImports.includes(kind)} onChange={event => setHostImports(items => event.target.checked ? [...items, kind] : items.filter(item => item !== kind))} /><span>{t(`packages.hostImports.${kind}`)}<span className="mt-1 block font-mono text-xs text-muted-foreground">{contract}</span></span></label>)}</div></fieldset>
      <div><Button size="sm" variant="outline" disabled={!implementation || !nodeId.trim() || !bindingId.trim() || nodes.some(node => node.id === nodeId.trim())} onClick={() => {
        if (!implementation) return; change(); setNodes(items => [...items, { id: nodeId.trim(), bindingId: bindingId.trim(), installId: implementation.record.installId, providerId: implementation.item.providerId, artifactId: implementation.item.artifactId, slot: implementation.item.slot, stateNamespace: namespace || null, required, hostImports: [...hostImports] }]); setNodeId(''); setHostImports([]);
      }}>{t('packages.addNode')}</Button></div></fieldset>
      <DataTable columns={[t('packages.node'), t('packages.exactImplementation'), t('packages.binding'), t('packages.hostImports.title'), t('packages.entryAndTrust'), t('packages.remove')]} empty={t('packages.emptySelection')} rows={nodes.map(node => [node.id, `${node.installId} / ${node.providerId} / ${node.artifactId} / ${node.slot}`, node.bindingId, node.hostImports.map(kind => t(`packages.hostImports.${kind}`)).join(' / ') || t('shared.empty'), <div className="space-x-3"><label><input type="checkbox" checked={roots.includes(node.id)} onChange={event => { change(); setRoots(items => event.target.checked ? [...items, node.id] : items.filter(id => id !== node.id)); }} />{t('packages.entry')}</label><label><input type="checkbox" checked={trustedRoots.includes(node.id)} onChange={event => { change(); setTrustedRoots(items => event.target.checked ? [...items, node.id] : items.filter(id => id !== node.id)); }} />{t('packages.trustedEntry')}</label></div>, <button type="button" className="underline" onClick={() => { change(); setNodes(items => items.filter(item => item.id !== node.id)); setRoots(items => items.filter(id => id !== node.id)); setTrustedRoots(items => items.filter(id => id !== node.id)); setEdges(items => items.filter(edge => edge.consumer !== node.id && edge.provider !== node.id)); setCompositions([]); }}>{t('packages.remove')}</button>])} />
      <fieldset className="grid gap-3 rounded-xl border border-border p-4"><legend className="px-1 text-sm font-medium">{t('packages.dependencyLegend')}</legend><div className="grid gap-3 sm:grid-cols-2"><Field label={t('packages.consumerNode')}><select className={selectClass} value={consumer} onChange={event => { setConsumer(event.target.value); setConsumerPort(''); }}><option value="">{t('packages.selectNode')}</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.id}</option>)}</select></Field><Field label={t('packages.requiredContract')}><select className={selectClass} value={consumerPort} onChange={event => setConsumerPort(event.target.value)}><option value="">{t('packages.selectRequiredContract')}</option>{sourceRecord?.manifest.requires.map(item => <option key={item.id} value={item.id}>{item.id} · {item.version}</option>)}</select></Field><Field label={t('packages.providerNode')}><select className={selectClass} value={provider} onChange={event => { setProvider(event.target.value); setProviderPort(''); }}><option value="">{t('packages.selectNode')}</option>{nodes.filter(node => node.id !== consumer).map(node => <option key={node.id} value={node.id}>{node.id}</option>)}</select></Field><Field label={t('packages.exportedContract')}><select className={selectClass} value={providerPort} onChange={event => setProviderPort(event.target.value)}><option value="">{t('packages.selectExportedContract')}</option>{targetImplementation?.contracts.map(item => <option key={item.id} value={item.id}>{item.id} · {item.version}</option>)}</select></Field></div><div><Button size="sm" variant="outline" disabled={!source || !target || !consumerPort || !providerPort || edges.some(edge => edge.consumer === consumer && edge.consumerPort === consumerPort)} onClick={() => { change(); setEdges(items => [...items, { consumer, consumerPort, provider, providerPort }]); }}>{t('packages.addDependency')}</Button></div></fieldset>
      <DataTable columns={[t('packages.consumerPort'), t('packages.providerPort'), t('packages.remove')]} empty={t('packages.emptySelection')} rows={edges.map((edge, index) => [`${edge.consumer} / ${edge.consumerPort}`, `${edge.provider} / ${edge.providerPort}`, <button type="button" className="underline" onClick={() => { change(); setEdges(items => items.filter((_, position) => position !== index)); }}>{t('packages.remove')}</button>])} />
      <fieldset className="grid gap-3 rounded-xl border border-border p-4"><legend className="px-1 text-sm font-medium">{t('packages.compositionLegend')}</legend><Field label={t('packages.compositionBinding')}><select className={selectClass} value={compositionBinding} onChange={event => { setCompositionBinding(event.target.value); setOrder([]); setWiring([]); }}><option value="">{t('packages.selectBinding')}</option>{bindings.map(id => <option key={id} value={id}>{id}</option>)}</select></Field><div className="grid gap-3 sm:grid-cols-3"><Field label={t('packages.executionMode')}><select className={selectClass} value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="">{t('packages.select')}</option>{modes.map(mode => <option key={mode} value={mode}>{t(`packages.modes.${mode}`)}</option>)}</select></Field><Field label={t('packages.mergeRule')}><select className={selectClass} value={merge} onChange={event => setMerge(event.target.value as typeof merge)}><option value="">{t('packages.select')}</option>{merges.map(merge => <option key={merge} value={merge}>{t(`packages.merges.${merge}`)}</option>)}</select></Field><Field label={t('packages.failureRule')}><select className={selectClass} value={failure} onChange={event => setFailure(event.target.value as typeof failure)}><option value="">{t('packages.select')}</option><option value="fail_closed">{t('packages.failures.fail_closed')}</option><option value="collect_independent">{t('packages.failures.collect_independent')}</option></select></Field></div>
      <p className="text-xs text-muted-foreground">{t('packages.orderHint')}</p><div className="flex flex-wrap gap-2">{nodes.filter(node => node.bindingId === compositionBinding).map(node => <Button type="button" size="sm" variant="outline" key={node.id} aria-pressed={order.includes(node.id)} onClick={() => setOrder(items => items.includes(node.id) ? items.filter(id => id !== node.id) : [...items, node.id])}>{order.includes(node.id) ? `${order.indexOf(node.id) + 1}. ` : ''}{node.id}</Button>)}</div>
      <div className="grid gap-3 sm:grid-cols-2"><Field label={t('packages.outputNode')}><select className={selectClass} value={output} onChange={event => setOutput(event.target.value)}><option value="">{t('packages.selectCompositionNode')}</option>{nodes.filter(node => node.bindingId === compositionBinding).map(node => <option key={node.id} value={node.id}>{node.id}</option>)}</select></Field><TextField label={t('packages.outputPort')} value={outputPort} onChange={setOutputPort} required={false} /><Field label={t('packages.inputNode')}><select className={selectClass} value={input} onChange={event => setInput(event.target.value)}><option value="">{t('packages.selectCompositionNode')}</option>{nodes.filter(node => node.bindingId === compositionBinding).map(node => <option key={node.id} value={node.id}>{node.id}</option>)}</select></Field><TextField label={t('packages.inputPort')} value={inputPort} onChange={setInputPort} required={false} /></div><div><Button size="sm" variant="outline" disabled={!output || !input || output === input || !outputPort.trim() || !inputPort.trim()} onClick={() => setWiring(items => [...items, { projection: 'compiler_ir', outputNode: output, outputPort: outputPort.trim(), inputNode: input, inputPort: inputPort.trim() }])}>{t('packages.addDataflow')}</Button></div><DataTable columns={[t('packages.output'), t('packages.input'), t('packages.remove')]} empty={t('packages.emptySelection')} rows={wiring.map((edge, index) => [`${edge.outputNode} / ${edge.outputPort}`, `${edge.inputNode} / ${edge.inputPort}`, <button type="button" className="underline" onClick={() => setWiring(items => items.filter((_, position) => position !== index))}>{t('packages.remove')}</button>])} /><div><Button size="sm" variant="outline" disabled={!compositionBinding || !mode || !merge || !failure} onClick={() => { if (!mode || !merge || !failure) return; change(); setCompositions(items => [...items.filter(item => item.bindingId !== compositionBinding), { bindingId: compositionBinding, nodes: nodes.filter(node => node.bindingId === compositionBinding).map(node => node.id), mode, merge, failure, order, wiring }]); }}>{t('packages.confirmComposition')}</Button></div></fieldset>
      <FixedRecord value={compositions} />
      <fieldset className="grid gap-3 rounded-xl border border-border p-4"><legend className="px-1 text-sm font-medium">{t('packages.channelsLegend')}</legend><div className="flex flex-wrap items-end gap-3"><TextField label={t('packages.bindingChannel')} value={channel} onChange={setChannel} /><Button size="sm" variant="outline" disabled={!world || !channel.trim()} onClick={() => { void readHead(); }}>{t('packages.readHead')}</Button></div><DataTable columns={[t('packages.channelsLegend'), t('packages.currentLock'), t('packages.revision')]} empty={t('packages.emptySelection')} rows={heads.map(head => [head.channel, head.expected?.activationLockId ?? t('packages.noActiveHead'), head.expected?.revision ?? t('packages.initialHead')])} />{bindings.map(binding => <Field key={binding} label={t('packages.bindingChannelLabel', { binding })}><select required className={selectClass} value={channels[binding] ?? ''} onChange={event => { change(); setChannels(items => ({ ...items, [binding]: event.target.value })); }}><option value="">{t('packages.selectReadChannel')}</option>{heads.map(head => <option key={head.channel} value={head.channel}>{head.channel}</option>)}</select></Field>)}</fieldset>
      <TextField label={t('packages.lockId')} value={lockId} onChange={value => { change(); setLockId(value); }} /><div><Button size="sm" disabled={planning || state.busy || !nodes.length || !roots.length || !heads.length || !lockId.trim() || bindings.some(binding => !channels[binding] || !compositions.some(composition => composition.bindingId === binding))} onClick={() => { void build(); }}>{planning ? t('packages.planning') : t('packages.buildPlan')}</Button></div>
      {plan ? <div className="space-y-4 rounded-xl border border-border p-4"><FixedRecord value={plan} /><p className="text-xs text-muted-foreground">{t('packages.activationNotice')}</p><Button size="sm" disabled={state.busy || planning} onClick={() => { void activate(); }}>{t('packages.confirmActivation')}</Button></div> : <Empty>{t('packages.planEmpty')}</Empty>}
    </div>
  </Section></div></details></div>;
}
