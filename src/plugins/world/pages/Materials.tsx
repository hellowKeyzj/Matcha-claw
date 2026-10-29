import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, FileUp, Link2, BookOpen, ClipboardCheck } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { hostWikiFiles, hostWikiHistoryList } from '@/lib/host-api';
import { normalizeFiles } from '@/plugins/wiki/wiki-model';
import { useWikiProjectsStore } from '@/plugins/wiki/wiki-projects';
import { useWorldStore, type MaterialImportOptions } from '../store';
import { queryWorld, sameWorld } from '../store/client';
import type { ActivationLock, Budget, CandidateCompileSelection, CompileRequest, MaterialCompileSelection, MaterialDraft, TaskSummary } from '@/types/world';
import type { WikiHistoryEntry } from '@/types/wiki-capabilities';
import { DataTable, Empty, Field, selectClass, SmallButton, TextField } from './components';
import { ConnectionForm, SourceDiscovery } from './SourceConnection';
import { FixedRecord } from './Definitions';
import { CompileTargetFields, ExternalContractFields } from './CompileSelection';
import { MaterialReadback } from './MaterialReadback';

export function BudgetFields({ budget, setBudget }: { budget: Budget; setBudget(value: Budget): void }) {
  const { t } = useTranslation('world');
  return <details className="rounded-xl border border-border p-3"><summary className="cursor-pointer text-sm">{t('materials.budget.title')}</summary><p className="mt-3 text-xs text-muted-foreground">{t('materials.budget.hint')}</p><div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-3">{([
    'maxWallTime', 'maxSteps', 'maxSourceReads', 'maxRows', 'maxBytes', 'maxModelCalls', 'maxInputTokens', 'maxOutputTokens',
  ] as const).map(key => <TextField key={key} label={t(`materials.budget.${key}`)} value={budget[key]} onChange={value => setBudget({ ...budget, [key]: value })} />)}</div></details>;
}

function WikiImport({ options }: { options: MaterialImportOptions | null }) {
  const { t } = useTranslation('world');
  const projects = useWikiProjectsStore(state => state.projects);
  const [project, setProject] = useState('');
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState<ReturnType<typeof normalizeFiles>>([]);
  const [path, setPath] = useState('');
  const [versions, setVersions] = useState<WikiHistoryEntry[]>([]);
  const [version, setVersion] = useState('');
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [error, setError] = useState('');
  const state = useWorldStore();
  const historyGeneration = useRef(0);
  const invalidateHistory = useCallback(() => ++historyGeneration.current, []);
  useEffect(() => { void useWikiProjectsStore.getState().refresh().catch(() => setError('materials.wiki.loadProjectsFailed')); }, []);
  useEffect(() => {
    let current = true; invalidateHistory();
    if (project) void hostWikiFiles({ projectId: project, directory }).then(value => { if (current) setEntries(normalizeFiles(value)); }, () => { if (current) setError('materials.wiki.loadDirectoryFailed'); });
    return () => { current = false; invalidateHistory(); };
  }, [project, directory, invalidateHistory]);
  const openDirectory = (value: string) => {
    invalidateHistory();
    setDirectory(value); setEntries([]); setVersions([]); setVersion(''); setPath(''); setLoadingVersions(false); setError('');
  };
  const load = (path: string) => {
    const generation = invalidateHistory();
    setPath(path); setVersions([]); setVersion(''); setLoadingVersions(true); setError('');
    void hostWikiHistoryList({ projectId: project, path }).then(receipt => {
      if (generation !== historyGeneration.current) return;
      if (receipt.projectId !== project || receipt.path !== path || receipt.entries.some(entry => entry.path !== path)) throw new Error('Wiki version response mismatch');
      setVersions(receipt.entries);
    }).catch(() => { if (generation === historyGeneration.current) setError('materials.wiki.loadVersionsFailed'); })
      .finally(() => { if (generation === historyGeneration.current) setLoadingVersions(false); });
  };
  const selectedVersion = versions.find(entry => entry.id === version && entry.path === path);
  const ready = state.world && state.description?.status === 'ready' && sameWorld(state.world, state.description.world);
  const blocked = state.busy || state.operationBusy || Boolean(state.pending) || Boolean(state.pendingOperation) || state.transferBusy;
  return <div className="grid min-w-0 gap-4">
    <p className="text-sm text-muted-foreground">{t('materials.wiki.hint')}</p>
    <Field label={t('materials.wiki.library')}><select className={selectClass} value={project} onChange={event => { setProject(event.target.value); openDirectory(''); }}><option value="">{t('materials.wiki.selectLibrary')}</option>{projects.map(item => <option key={item.projectId} value={item.projectId}>{item.title}</option>)}</select></Field>
    {project && <>
      <div className="flex min-w-0 items-center gap-2 text-sm"><SmallButton onClick={() => openDirectory(directory.split('/').slice(0, -1).join('/'))} disabled={!directory}>{t('materials.wiki.parent')}</SmallButton><span className="truncate text-muted-foreground">{directory || t('materials.wiki.root')}</span></div>
      <div className="max-h-60 overflow-y-auto rounded-lg border border-[hsl(var(--shell-border))]">{entries.map(entry => <button className={`flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-[hsl(var(--shell-surface-muted))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40 ${path === entry.path ? 'bg-[hsl(var(--shell-surface-muted))] font-medium' : ''}`} type="button" key={entry.path} aria-pressed={!entry.isDirectory && path === entry.path} onClick={() => entry.isDirectory ? openDirectory(entry.path) : load(entry.path)} disabled={!entry.isDirectory && !(entry.path.startsWith('raw/sources/') || (entry.path.startsWith('wiki/') && entry.path.endsWith('.md') && !entry.path.startsWith('wiki/media/')))}><BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate">{entry.isDirectory ? t('materials.wiki.directory', { name: entry.label }) : entry.label}</span></button>)}</div>
      {path && <Field label={t('materials.wiki.version', { path })}><select className={selectClass} value={version} disabled={loadingVersions} onChange={event => setVersion(event.target.value)}><option value="">{loadingVersions ? t('shell.processing') : t('materials.wiki.selectVersion')}</option>{versions.map(entry => <option value={entry.id} key={entry.id}>{new Date(entry.timestamp).toLocaleString()} · {entry.author || entry.tool}</option>)}</select></Field>}
      {path && !loadingVersions && !versions.length && <p className="text-sm text-muted-foreground">{t('materials.wiki.noVersions')}</p>}
      {selectedVersion && <div className="min-w-0 overflow-hidden rounded-lg border border-[hsl(var(--shell-border))]"><p className="break-all border-b border-[hsl(var(--shell-border))] px-3 py-2 font-mono text-xs text-muted-foreground">{project} / {path} / {selectedVersion.id}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words bg-[hsl(var(--shell-surface-muted))] p-3 text-xs leading-relaxed">{selectedVersion.content.slice(0, 2000)}</pre></div>}
      <div className="flex justify-end border-t border-[hsl(var(--shell-border))] pt-4"><Button type="button" size="sm" disabled={!ready || !selectedVersion || blocked || !options} onClick={() => { if (!ready || blocked || !selectedVersion || !options) return; void useWorldStore.getState().importSelection(path.startsWith('wiki/') ? { kind: 'wiki_page', projectId: project, pageId: path, version: selectedVersion.id } : { kind: 'wiki_source', projectId: project, sourceId: path, version: selectedVersion.id }, options).catch(() => undefined); }}>{t('materials.wiki.import')}</Button></div>
    </>}
    {error && <p className="text-sm text-destructive" role="alert">{t(error)}</p>}
  </div>;
}

function MaterialProposalForm({ draft, context, tasks, blocked }: { draft: MaterialDraft; context: CompileRequest; tasks: TaskSummary[]; blocked: boolean }) {
  const { t } = useTranslation('world');
  const navigate = useNavigate();
  const [taskKey, setTaskKey] = useState('');
  const [lock, setLock] = useState<ActivationLock | null>(context.activationLock);
  const [candidates, setCandidates] = useState<Map<string, CandidateCompileSelection>>(new Map());
  const task = tasks.find(item => JSON.stringify(item.reference) === taskKey
    && sameWorld(item.reference.world, draft.reference.world) && item.scope === draft.scope);
  const complete = draft.batch.candidates.length > 0 && draft.batch.candidates.every(item => candidates.has(item.id));
  const disabled = blocked || !task || !lock || !complete || !!draft.batch.readNeeds.length;
  return <form className="grid gap-4 border-t border-[hsl(var(--shell-border))] pt-5" onSubmit={event => {
    event.preventDefault(); if (disabled || !task || !lock) return;
    const compile: MaterialCompileSelection = { activationLockId: lock.id, candidates: Array.from(candidates.values()) };
    void useWorldStore.getState().command({ kind: 'propose_material_draft', request: { draft: draft.reference, task: task.reference, compile } })
      .then(result => navigate(result.kind === 'accepted' ? '/world/settings?tab=operations' : '/world/changes')).catch(() => undefined);
  }}>
    <Field label={t('materials.draft.task')}><select required className={selectClass} value={taskKey} onChange={event => { setTaskKey(event.target.value); setCandidates(new Map()); }}><option value="">{t('materials.draft.selectTask')}</option>{tasks.map(item => <option key={JSON.stringify(item.reference)} value={JSON.stringify(item.reference)}>{item.goal}</option>)}</select></Field>
    {task && <details className="rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('materials.draft.taskDetails')}</summary><div className="mt-3"><FixedRecord value={task.reference} /></div></details>}
    <fieldset className="grid min-w-0 gap-5 rounded-[10px] border border-[hsl(var(--shell-border))] p-4">
      <legend className="px-1 text-sm font-semibold">{t('compile.title')}</legend>
      <p className="text-sm leading-relaxed text-muted-foreground">{t('materials.draft.compileDescription')}</p>
      <CompileTargetFields context={context} lock={lock} onChange={value => { setLock(value); setCandidates(new Map()); }} />
      <p className="text-sm text-muted-foreground" role="status">{t('materials.draft.compileProgress', { confirmed: candidates.size, total: draft.batch.candidates.length })}</p>
      {draft.batch.candidates.map(candidate => <fieldset key={candidate.id} className="grid min-w-0 gap-4 rounded-lg border border-[hsl(var(--shell-border))] p-4">
        <legend className="break-all px-1 text-sm font-medium">{t('materials.draft.candidateCompile', { id: candidate.id })}</legend>
        <ExternalContractFields key={lock?.id ?? ''} context={context} lock={lock} confirmed={candidates.has(candidate.id)} definitionDrafts={candidate.changeSet.operations.flatMap(operation => operation.kind === 'create_definition' ? [operation.definition] : operation.kind === 'refine_definition' || operation.kind === 'supersede_rule' ? [operation.replacement] : operation.kind === 'split_definition' ? operation.replacements : [])} onChange={externalContracts => {
          setCandidates(previous => {
            const next = new Map(previous);
            if (externalContracts) next.set(candidate.id, { candidateId: candidate.id, externalContracts }); else next.delete(candidate.id);
            return next;
          });
        }} />
      </fieldset>)}
    </fieldset>
    {!tasks.length && <p className="text-sm text-muted-foreground">{t('materials.draft.noTasks')}</p>}
    <div className="flex justify-end"><Button size="sm" disabled={disabled}>{t('materials.draft.propose')}</Button></div>
  </form>;
}

function MaterialDraftReview() {
  const { t } = useTranslation('world');
  const state = useWorldStore();
  const reference = state.materialDraft;
  const [draft, setDraft] = useState<MaterialDraft | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    const world = state.world;
    if (world && reference && sameWorld(world, reference.world) && state.description?.status === 'ready') {
      void queryWorld(world, { kind: 'material_draft', request: reference }, 'material_draft').then(async value => {
        if (!current) return;
        if (!sameWorld(value.reference.world, world) || value.reference.runId !== reference.runId
          || value.reference.stepId !== reference.stepId || value.reference.revision !== reference.revision) throw new Error(t('materials.draft.responseMismatch'));
        setDraft(value);
        const page = await queryWorld(world, { kind: 'tasks', request: { scope: value.scope, page: { limit: 100, cursor: null } } }, 'tasks');
        if (current) setTasks(page.items);
      }).catch(error => { if (current) setError(error instanceof Error ? error.message : t('materials.draft.loadFailed')); });
    }
    return () => { current = false; };
  }, [state.world, reference, state.description?.incarnation, state.description?.revision, state.description?.status, t]);
  const context = state.description?.editingContext;
  const compatible = draft && reference && state.world && state.description?.status === 'ready'
    && sameWorld(draft.reference.world, state.world) && sameWorld(draft.reference.world, reference.world)
    && draft.reference.runId === reference.runId && draft.reference.stepId === reference.stepId && draft.reference.revision === reference.revision
    && context && sameWorld(context.world, state.world) && context.baseRelease === draft.baseRelease;
  const blocked = state.busy || state.operationBusy || Boolean(state.pending) || Boolean(state.pendingOperation) || state.transferBusy;
  if (!reference) return null;
  return <section className="world-panel min-w-0"><header className="world-panel-header"><div><h2 className="text-base font-semibold">{t('materials.draft.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('atelier.materials.reviewHint')}</p></div><ClipboardCheck className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" /></header>
      <div className="world-panel-body space-y-5">
        {draft ? <>
          <DataTable columns={[t('materials.draft.candidate'), t('materials.draft.changes'), t('materials.draft.evidence')]} rows={draft.batch.candidates.map((candidate, index) => [<details><summary className="cursor-pointer">{t('materials.draft.candidateNumber', { number: index + 1 })}</summary><p className="mt-2 break-all text-xs text-muted-foreground">{candidate.id}</p></details>, <FixedRecord value={candidate.changeSet.operations} />, <details><summary className="cursor-pointer">{t('materials.draft.evidenceCount', { count: candidate.evidence.length })}</summary><p className="mt-2 break-all text-xs text-muted-foreground">{candidate.evidence.map(item => item.reference.id).join(' / ')}</p></details>])} empty={t('materials.draft.noCandidates')} />
          <details className="rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('materials.draft.evidenceAndObservations')} · {draft.batch.evidence.length} / {draft.batch.observations.length}</summary><div className="mt-3 space-y-4"><FixedRecord value={draft.batch.evidence} /><FixedRecord value={draft.batch.observations} /></div></details>
          <DataTable columns={[t('materials.draft.coverage'), t('materials.draft.gapReason'), t('materials.draft.location')]} rows={draft.batch.coverage.map(item => [item.status, item.reason?.kind ?? t('materials.draft.notProvided'), <FixedRecord value={item.anchor} />])} empty={t('materials.draft.noCoverage')} />
          <MaterialReadback sources={draft.sourceVersions} artifacts={draft.parseArtifacts} />
          {!!draft.batch.readNeeds.length && <div className="space-y-3"><p className="text-sm text-destructive">{t('materials.draft.readsRequired')}</p><DataTable columns={[t('materials.draft.sourceVersions'), t('materials.draft.readReason'), t('materials.draft.location')]} rows={draft.batch.readNeeds.map(item => [`${item.sourceVersion.sourceId} · ${item.sourceVersion.versionId}`, item.reason, <FixedRecord value={item.targets} />])} /></div>}
          {compatible && context ? <MaterialProposalForm key={JSON.stringify([draft.reference, context.baseRelease, context.activationLock.id, context.configDigest])} draft={draft} context={context} tasks={tasks} blocked={blocked} />
            : <p className="text-sm text-muted-foreground">{t('materials.draft.baseChanged')}</p>}
        </> : <p className="text-sm text-muted-foreground" role="status">{t('materials.draft.loading')}</p>}
        {draft && <details className="border-t border-[hsl(var(--shell-border))] pt-4"><summary className="cursor-pointer text-sm">{t('materials.draft.details')}</summary><dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">{[
          [t('materials.draft.runRevision'), `${draft.reference.runId} / ${draft.reference.revision}`], [t('materials.draft.baseRelease'), draft.baseRelease], [t('materials.scope'), draft.scope], [t('materials.draft.sourceVersions'), draft.sourceVersions.map(item => `${item.sourceId} · ${item.versionId}`).join(' / ')], [t('materials.draft.parseArtifacts'), draft.parseArtifacts.join(' / ')],
        ].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-all">{value || t('model.record.none')}</dd></div>)}</dl></details>}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </div>
    </section>;
}

export function Materials() {
  const world = useWorldStore(state => state.world);
  return <MaterialsView key={JSON.stringify(world)} />;
}

function MaterialsView() {
  const { t } = useTranslation('world');
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedMode = searchParams.get('mode');
  const mode = requestedMode === 'upload' || requestedMode === 'wiki' || requestedMode === 'connection' || requestedMode === 'draft' ? requestedMode : null;
  const setMode = (value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('mode', value); else next.delete('mode');
    setSearchParams(next, { replace: true });
  };
  const [localError, setLocalError] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [accessId, setAccessId] = useState('');
  const [retentionId, setRetentionId] = useState('');
  const [budget, setBudget] = useState<Budget>({ maxWallTime: '120000', maxSteps: '100', maxSourceReads: '100', maxRows: '10000', maxBytes: '268435456', maxModelCalls: '10', maxInputTokens: '100000', maxOutputTokens: '20000' });
  const state = useWorldStore();
  const validBudget = Object.values(budget).every(value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) && BigInt(budget.maxWallTime) > 0n && BigInt(budget.maxSteps) > 0n;
  const scopes = state.description?.materialScopes ?? [];
  const scope = scopes.find(item => item.scope === scopeId);
  const access = scope?.access.find(item => `${item.policyId}:${item.revision}` === accessId);
  const retention = scope?.retention.find(item => `${item.policyId}:${item.revision}` === retentionId);
  const ready = state.world && state.description?.status === 'ready' && sameWorld(state.world, state.description.world);
  const blocked = state.busy || state.operationBusy || Boolean(state.pending) || Boolean(state.pendingOperation) || state.transferBusy;
  const options: MaterialImportOptions | null = ready && validBudget && scope && access && retention ? { scope: scope.scope, access, retention, budget } : null;
  const [selected, setSelected] = useState<{ kind: 'material' | 'connection'; key: string } | null>(null);
  const selectedMaterial = state.materials.find(item => selected?.kind === 'material' && JSON.stringify(item.reference) === selected.key);
  const selectedConnection = state.connections.find(item => selected?.kind === 'connection' && JSON.stringify([item.id, item.revision, item.sourceId]) === selected.key);
  const upload = state.upload && state.world && sameWorld(state.upload.world, state.world)
    && (!state.upload.submission || state.upload.submission.kind === 'import_materials') ? state.upload : null;
  const materialImport = upload?.submission?.kind === 'import_materials' ? upload.submission : undefined;
  const importPending = Boolean(materialImport && state.pending?.request.command.kind === 'import_materials'
    && state.pending.request.requestId === materialImport.requestId && sameWorld(state.pending.request.world, materialImport.world));
  const currentStep = state.pending ? 'shell.pendingRequest' : state.pendingOperation ? 'shell.pendingOperation' : blocked ? 'shell.processing' : !options ? 'atelier.materials.authorizeImport' : mode === 'wiki' ? 'atelier.materials.selectVersion' : 'materials.selectFile';
  return <div className="world-content-page space-y-5">
    {mode ? <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}><ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />{t('materials.back')}</Button> : <section className="flex min-w-0 flex-wrap items-center justify-between gap-5 rounded-xl border border-dashed border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface-muted))] p-6">
      <div className="flex min-w-0 items-center gap-4"><FileUp className="h-7 w-7 shrink-0 text-muted-foreground" aria-hidden="true" /><h2 className="text-base font-semibold">{t('atelier.materials.importTitle')}</h2></div>
      <div className="flex min-w-0 max-w-full flex-wrap gap-2"><Button type="button" size="sm" disabled={!ready} onClick={() => setMode('upload')}>{t('materials.methods.upload')}</Button><Button type="button" size="sm" variant="outline" disabled={!ready} onClick={() => setMode('wiki')}><BookOpen className="mr-2 h-4 w-4" aria-hidden="true" />{t('materials.methods.wiki')}</Button></div>
    </section>}
    {mode !== 'connection' && <ol className="world-step-track text-xs text-muted-foreground" aria-label={t('materials.title')}>
      <li className="flex items-center gap-2"><span className="font-mono">01</span>{t('materials.add')}</li>
      <li className="flex items-center gap-2"><span className="font-mono">02</span>{t('atelier.materials.reviewEvidence')}</li>
      <li className="flex items-center gap-2"><span className="font-mono">03</span>{t('materials.draft.propose')}</li>
      <li><Link className="inline-flex items-center gap-2 underline underline-offset-4" to="/world/changes"><span className="font-mono">04</span>{t('pages.changes')}<ArrowRight className="h-3 w-3" aria-hidden="true" /></Link></li>
    </ol>}
    {upload && (!state.busy || materialImport) && <section className="world-panel" aria-label={t('atelier.materials.importReceipt')} data-material-import-request={materialImport?.requestId}>
      <div className="world-panel-body space-y-3">
        {!state.busy && <p className="break-words text-sm">{upload.name}<span className="ml-2 text-muted-foreground">{upload.state}</span></p>}
        {materialImport && <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('atelier.materials.importReceipt')}</summary><div className="mt-3"><FixedRecord value={{ world: materialImport.world, requestId: materialImport.requestId }} /></div></details>}
        {importPending && <p className="text-sm text-muted-foreground" role="status">{t('materials.upload.pending')}</p>}
        {materialImport?.failure && <div className="space-y-2 text-sm text-destructive" role="alert"><p>{materialImport.failure.message}</p><details><summary className="cursor-pointer">{t('shell.diagnostic')}</summary><FixedRecord value={materialImport.failure} /></details></div>}
        <Link className="inline-block text-xs underline underline-offset-4" to="/world/settings?tab=operations">{t('shell.openRecords')}</Link>
      </div>
    </section>}
    {mode === 'draft' ? <MaterialDraftReview key={JSON.stringify([state.world, state.materialDraft, state.description?.incarnation, state.description?.revision, state.description?.status])} /> : mode === 'connection' ? <ConnectionForm key={JSON.stringify(state.world)} /> : mode ? <section className="world-panel min-w-0"><header className="world-panel-header"><div><h2 className="text-base font-semibold">{t(`materials.methods.${mode}`)}</h2></div>{mode === 'upload' ? <FileUp className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" /> : <BookOpen className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />}</header>
        <div className="world-panel-body space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><p role="status">{t(currentStep)}</p><p>{t('atelier.materials.reviewHint')}</p></div>
          <fieldset className="grid gap-4"><legend className="mb-3 text-sm font-medium">{t('materials.policies')}</legend>
            <Field label={t('materials.scope')}><select required className={selectClass} value={scopeId} onChange={event => { setScopeId(event.target.value); setAccessId(''); setRetentionId(''); }}><option value="">{t('materials.selectScope')}</option>{scopes.map(item => <option key={item.scope} value={item.scope}>{item.scope}</option>)}</select></Field>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4"><Field label={t('materials.accessPolicy')}><select required className={selectClass} value={accessId} onChange={event => setAccessId(event.target.value)}><option value="">{t('materials.selectAccessPolicy')}</option>{scope?.access.map(item => <option key={`${item.policyId}:${item.revision}`} value={`${item.policyId}:${item.revision}`}>{item.policyId} · {item.revision}{item.labels.length ? ` · ${item.labels.join(' / ')}` : ''}</option>)}</select></Field><Field label={t('materials.retentionPolicy')}><select required className={selectClass} value={retentionId} onChange={event => setRetentionId(event.target.value)}><option value="">{t('materials.selectRetentionPolicy')}</option>{scope?.retention.map(item => <option key={`${item.policyId}:${item.revision}`} value={`${item.policyId}:${item.revision}`}>{item.policyId} · {item.revision}</option>)}</select></Field></div>
            {!scopes.length && <p className="text-sm text-muted-foreground">{t('materials.noPolicies')}</p>}
          </fieldset>
          <BudgetFields budget={budget} setBudget={setBudget} />
          <div className="border-t border-[hsl(var(--shell-border))] pt-5">{mode === 'upload' ? <div className="space-y-3"><Field label={t('materials.selectFile')}><Input type="file" className="h-auto bg-[hsl(var(--shell-surface-muted))] py-3" disabled={!ready || blocked || !options} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
            if (file.size > 256 * 1024 * 1024) { setLocalError('materials.fileTooLarge'); return; }
            if (!ready || blocked || !options) return;
            setLocalError(''); void state.uploadFile(file, options).catch(() => undefined);
          }} /></Field><p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.materials.uploadLimit')}</p></div> : <WikiImport options={options} />}</div>
          {localError && <p className="text-sm text-destructive" role="alert">{t(localError)}</p>}
        </div>
      </section> : <div className="min-w-0 space-y-6">
      <section className="world-panel min-w-0">
        <header className="world-panel-header"><div><h2 className="text-base font-semibold">{t('atelier.materials.catalog')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('atelier.materials.catalogHint')}</p></div></header>
        {state.materialDraft && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(var(--shell-border))] px-5 py-3"><div className="flex items-center gap-3"><ClipboardCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><p className="text-sm">{t('materials.draftAvailable')}</p></div><SmallButton onClick={() => setMode('draft')}>{t('materials.reviewDraft')}</SmallButton></div>}
        <DataTable columns={[t('materials.document'), t('materials.source'), t('materials.addedAt'), t('materials.size'), t('connections.details')]} rowKeys={state.materials.map(item => JSON.stringify(item.reference))} selectedRowKey={selected?.kind === 'material' ? selected.key : undefined} onRowSelect={key => setSelected({ kind: 'material', key })} rows={state.materials.map(item => [<span><span className="block font-medium">{item.mediaType}</span><span className="mt-1 block break-all text-xs text-muted-foreground">{item.reference.versionId}</span></span>, item.lineage.map(lineage => t(`materials.lineage.${lineage.kind}`)).join(' / ') || t('materials.lineage.upload'), new Date(item.capturedAt).toLocaleString(), t('materials.bytes', { size: item.blob.byteSize }), <button type="button" className="text-xs underline underline-offset-4" onClick={() => setSelected({ kind: 'material', key: JSON.stringify(item.reference) })}>{t('connections.viewDetails')}</button>])} empty={t('materials.empty')} />
        {selectedMaterial && <div className="border-t border-[hsl(var(--shell-border))]">
          <header className="world-panel-header"><h3 className="text-sm font-semibold">{t('atelier.materials.sourceDetails')}</h3><Button type="button" size="sm" variant="ghost" onClick={() => setSelected(null)}>{t('shared.close')}</Button></header>
          <div className="world-panel-body space-y-4"><MaterialReadback key={JSON.stringify(selectedMaterial.reference)} sources={[selectedMaterial.reference]} /><details><summary className="cursor-pointer text-sm">{t('atelier.materials.sourceIdentity')} · {t('materials.policies')}</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><section className="space-y-2"><h4 className="text-xs text-muted-foreground">{t('atelier.materials.sourceIdentity')}</h4><FixedRecord value={selectedMaterial.reference} /></section><section className="space-y-2"><h4 className="text-xs text-muted-foreground">{t('materials.accessPolicy')}</h4><FixedRecord value={selectedMaterial.access} /></section><section className="space-y-2"><h4 className="text-xs text-muted-foreground">{t('materials.retentionPolicy')}</h4><FixedRecord value={selectedMaterial.retention} /></section><section className="space-y-2"><h4 className="text-xs text-muted-foreground">{t('materials.source')}</h4><FixedRecord value={selectedMaterial.lineage} /></section></div></details></div>
        </div>}
      </section>
      <section className="world-panel min-w-0">
        <header className="world-panel-header"><h2 className="text-base font-semibold">{t('atelier.materials.connectSources')}</h2><Button type="button" size="sm" variant="outline" disabled={!ready} onClick={() => setMode('connection')}><Link2 className="mr-2 h-4 w-4" aria-hidden="true" />{t('materials.methods.connection')}</Button></header>
        <DataTable columns={[t('connections.name'), t('connections.status'), t('connections.details')]} rowKeys={state.connections.map(item => JSON.stringify([item.id, item.revision, item.sourceId]))} selectedRowKey={selected?.kind === 'connection' ? selected.key : undefined} onRowSelect={key => setSelected({ kind: 'connection', key })} rows={state.connections.map(item => [item.name, item.configured ? t('connections.configured') : t('connections.notConfigured'), <button type="button" className="text-left text-xs underline underline-offset-4" onClick={() => setSelected({ kind: 'connection', key: JSON.stringify([item.id, item.revision, item.sourceId]) })}>{t('connections.viewDetails')}</button>])} empty={t('connections.empty')} />
        {selectedConnection && <div className="border-t border-[hsl(var(--shell-border))]">
          <header className="world-panel-header"><h3 className="break-words text-sm font-semibold">{selectedConnection.name}</h3><Button type="button" size="sm" variant="ghost" onClick={() => setSelected(null)}>{t('shared.close')}</Button></header>
          <div className="world-panel-body space-y-4"><p className="text-xs text-muted-foreground">{t('connections.credentialsHint')}</p><details><summary className="cursor-pointer text-sm">{t('atelier.materials.connectionSummary')}</summary><div className="mt-3"><FixedRecord value={selectedConnection} /></div></details><SourceDiscovery key={JSON.stringify([state.world, selectedConnection, state.description?.incarnation])} connection={selectedConnection} /></div>
        </div>}
      </section>
    </div>}
    {!state.world && <Empty>{t('materials.selectWorld')}</Empty>}
  </div>;
}
