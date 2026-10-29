import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { queryWorld, sameWorld } from '../store/client';
import type { ActivationLock, CompileRequest, CompileSelection, Definition, ExternalContractSelection, ExternalContractUse } from '@/types/world';
import { DataTable, Field, selectClass, TextField } from './components';

function baseline(context: CompileRequest): ExternalContractSelection[] | null {
  const selections: ExternalContractSelection[] = [];
  for (const external of context.externalContracts) {
    const nodes = context.activationLock.nodes.filter(node => node.implementation.installId === external.implementation.installId
      && node.implementation.artifactId === external.implementation.artifactId
      && node.implementation.contracts.some(contract => contract.id === external.contract.id && contract.version === external.contract.version && contract.schemaDigest === external.contract.schemaDigest));
    if (nodes.length !== 1) return null;
    let kind: ExternalContractUse;
    switch (external.kind.kind) {
      case 'source': kind = { kind: 'source', binding: external.kind.binding }; break;
      case 'policy': kind = { kind: 'policy', policyId: external.kind.policy.policyId, revision: external.kind.policy.revision }; break;
      case 'compiler_pass': kind = { kind: 'compiler_pass' }; break;
      case 'definition_kind': kind = { kind: 'definition_kind', name: external.kind.name }; break;
      case 'function': kind = { kind: 'function', reference: external.kind.reference }; break;
    }
    selections.push({ nodeId: nodes[0].id, contractId: external.contract.id, kind });
  }
  return selections;
}

export function CompileSelectionFields({ context, definitionDrafts = [], onChange }: { context: CompileRequest; definitionDrafts?: readonly Definition[]; onChange(value: CompileSelection | null): void }) {
  const { t } = useTranslation('world');
  const [lock, setLock] = useState<ActivationLock | null>(context.activationLock);
  const [confirmed, setConfirmed] = useState(false);
  return <fieldset className="grid min-w-0 gap-5 rounded-[10px] border border-[hsl(var(--shell-border))] p-4">
    <legend className="px-1 text-sm font-semibold">{t('compile.title')}</legend>
    <p className="text-sm leading-relaxed text-muted-foreground">{t('compile.description')}</p>
    <CompileTargetFields context={context} lock={lock} onChange={value => { setLock(value); setConfirmed(false); onChange(null); }} />
    <ExternalContractFields key={lock?.id ?? ''} context={context} lock={lock} definitionDrafts={definitionDrafts} confirmed={confirmed} onChange={value => {
      setConfirmed(value !== null); onChange(lock && value ? { activationLockId: lock.id, externalContracts: value } : null);
    }} />
  </fieldset>;
}

export function CompileTargetFields({ context, lock, onChange }: { context: CompileRequest; lock: ActivationLock | null; onChange(value: ActivationLock | null): void }) {
  const { t } = useTranslation('world');
  const [locks, setLocks] = useState<ActivationLock[]>([context.activationLock]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<{ key: 'worldMismatch' | 'loadFailed' } | { message: string } | null>(null);
  useEffect(() => {
    let current = true;
    void queryWorld(context.world, { kind: 'bindings', request: { page: { limit: 100, cursor } } }, 'bindings').then(page => {
      if (!current) return;
      if (page.items.some(item => !sameWorld(item.world, context.world))) { setError({ key: 'worldMismatch' }); return; }
      setLocks(previous => [...previous.filter(item => !page.items.some(next => next.id === item.id)), ...page.items]);
      setNextCursor(page.nextCursor ?? null);
    }).catch(error => { if (current) setError(error instanceof Error ? { message: error.message } : { key: 'loadFailed' }); });
    return () => { current = false; };
  }, [context.world, cursor]);
  return <section className="grid min-w-0 gap-3">
    <h3 className="text-sm font-medium">{t('atelier.compile.basis')}</h3>
    <dl className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs"><dt className="text-muted-foreground">{t('materials.draft.baseRelease')}</dt><dd className="break-all font-mono">{context.baseRelease}</dd></dl>
    <Field label={t('compile.targetLock')}><select required className={selectClass} value={lock?.id ?? ''} onChange={event => onChange(locks.find(item => item.id === event.target.value) ?? null)}><option value="">{t('compile.selectLock')}</option>{locks.map(item => <option key={item.id} value={item.id}>{item.id}{item.id === context.activationLock.id ? ` · ${t('compile.currentBaseline')}` : ''}</option>)}</select></Field>
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={!cursor} onClick={() => setCursor(null)}>{t('compile.firstLockPage')}</Button><Button type="button" size="sm" variant="outline" disabled={!nextCursor} onClick={() => setCursor(nextCursor)}>{t('compile.nextLockPage')}</Button></div>
    {error && <p className="text-sm text-destructive" role="alert">{'key' in error ? t(`compile.errors.${error.key}`) : error.message}</p>}
  </section>;
}

export function ExternalContractFields({ context, lock, definitionDrafts = [], confirmed, onChange }: { context: CompileRequest; lock: ActivationLock | null; definitionDrafts?: readonly Definition[]; confirmed: boolean; onChange(value: ExternalContractSelection[] | null): void }) {
  const { t } = useTranslation('world');
  const [initial] = useState(() => lock?.id === context.activationLock.id ? baseline(context) : []);
  const [selections, setSelections] = useState<ExternalContractSelection[]>(initial ?? []);
  const [nodeId, setNodeId] = useState('');
  const [contractId, setContractId] = useState('');
  const [use, setUse] = useState<ExternalContractUse['kind'] | ''>('');
  const [definitionId, setDefinitionId] = useState('');
  const [name, setName] = useState('');
  const [policyId, setPolicyId] = useState('');
  const [policyRevision, setPolicyRevision] = useState('');
  const [error, setError] = useState<{ key: 'baselineAmbiguous' | 'selectionAmbiguous' } | null>(initial ? null : { key: 'baselineAmbiguous' });
  const node = lock?.nodes.find(item => item.id === nodeId);
  const definitions = [...new Map([...context.definitions, ...definitionDrafts].map(item => [item.reference.id, item])).values()]
    .filter(item => item.body.kind === (use === 'function' ? 'function' : 'source_binding'));
  const change = () => onChange(null);
  const add = () => {
    if (!node || !contractId || !use) return;
    const definition = definitions.find(item => `${item.reference.id}:${item.reference.revision}` === definitionId);
    let kind: ExternalContractUse;
    switch (use) {
      case 'definition_kind': if (!name.trim()) return; kind = { kind: use, name: name.trim() }; break;
      case 'function': if (!definition) return; kind = { kind: use, reference: definition.reference }; break;
      case 'source': if (!definition) return; kind = { kind: use, binding: definition.reference }; break;
      case 'policy': if (!policyId.trim() || !/^[1-9]\d*$/.test(policyRevision)) return; kind = { kind: use, policyId: policyId.trim(), revision: policyRevision }; break;
      case 'compiler_pass': kind = { kind: use }; break;
    }
    change(); setSelections(items => [...items, { nodeId: node.id, contractId, kind }]); setError(null);
  };
  return <>
    <section className="min-w-0 space-y-3 border-t border-[hsl(var(--shell-border))] pt-4">
      <h3 className="text-sm font-medium">{t('atelier.compile.contracts')}</h3>
      <DataTable columns={[t('compile.columns.node'), t('compile.columns.contract'), t('compile.columns.use'), t('compile.remove')]} rows={selections.map((item, index) => [item.nodeId, item.contractId, item.kind.kind === 'definition_kind' ? t('compile.selection.definitionKind', { name: item.kind.name }) : item.kind.kind === 'function' ? t('compile.selection.function', { id: item.kind.reference.id, revision: item.kind.reference.revision }) : item.kind.kind === 'source' ? t('compile.selection.source', { id: item.kind.binding.id, revision: item.kind.binding.revision }) : item.kind.kind === 'policy' ? t('compile.selection.policy', { id: item.kind.policyId, revision: item.kind.revision }) : t('compile.uses.compiler_pass'), <button type="button" className="underline underline-offset-4" onClick={() => { change(); setSelections(items => items.filter((_, position) => position !== index)); }}>{t('compile.remove')}</button>])} empty={t('compile.empty')} />
      <details className="min-w-0 rounded-lg border border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface-muted))] p-3">
        <summary className="cursor-pointer text-sm font-medium">{t('compile.addUse')}</summary>
        <div className="mt-4 grid min-w-0 gap-4">
          <fieldset className="grid min-w-0 gap-3">
            <legend className="mb-3 text-xs font-medium text-muted-foreground">{t('atelier.compile.provider')}</legend>
            <Field label={t('compile.targetNode')}><select className={selectClass} value={nodeId} onChange={event => { setNodeId(event.target.value); setContractId(''); }}><option value="">{t('compile.selectNode')}</option>{lock?.nodes.map(item => <option key={item.id} value={item.id}>{item.id} · {item.implementation.installId} / {item.providerId} / {item.implementation.artifactId} / {item.slot}</option>)}</select></Field>
            <Field label={t('compile.nodeContract')}><select className={selectClass} value={contractId} onChange={event => setContractId(event.target.value)}><option value="">{t('compile.selectContract')}</option>{node?.implementation.contracts.map(item => <option key={`${item.id}:${item.version}:${item.schemaDigest}`} value={item.id}>{item.id} · {item.version}</option>)}</select></Field>
          </fieldset>
          <div className="grid min-w-0 gap-3 border-t border-[hsl(var(--shell-border))] pt-4">
            <Field label={t('compile.use')}><select className={selectClass} value={use} onChange={event => { setUse(event.target.value as typeof use); setDefinitionId(''); }}><option value="">{t('compile.selectUse')}</option><option value="definition_kind">{t('compile.uses.definition_kind')}</option><option value="function">{t('compile.uses.function')}</option><option value="source">{t('compile.uses.source')}</option><option value="policy">{t('compile.uses.policy')}</option><option value="compiler_pass">{t('compile.uses.compiler_pass')}</option></select></Field>
            {use === 'definition_kind' && <TextField label={t('compile.definitionKindName')} value={name} onChange={setName} required={false} />}
            {(use === 'function' || use === 'source') && <Field label={use === 'function' ? t('compile.functionDefinition') : t('compile.sourceDefinition')}><select className={selectClass} value={definitionId} onChange={event => setDefinitionId(event.target.value)}><option value="">{t('compile.selectDefinition')}</option>{definitions.map(item => <option key={`${item.reference.id}:${item.reference.revision}`} value={`${item.reference.id}:${item.reference.revision}`}>{item.reference.id} · {item.reference.revision}</option>)}</select></Field>}
            {use === 'policy' && <><TextField label={t('compile.policyId')} value={policyId} onChange={setPolicyId} required={false} /><TextField label={t('compile.policyRevision')} value={policyRevision} onChange={setPolicyRevision} required={false} /></>}
          </div>
          <div><Button type="button" size="sm" variant="outline" disabled={!node || !contractId || !use} onClick={add}>{t('compile.addSelection')}</Button></div>
        </div>
      </details>
    </section>
    <footer className="space-y-3 border-t border-[hsl(var(--shell-border))] pt-4">
      <h3 className="text-sm font-medium">{t('atelier.compile.confirmation')}</h3>
      <Button type="button" size="sm" variant="outline" disabled={!lock} onClick={() => {
        if (!lock || selections.some(item => !lock.nodes.some(node => node.id === item.nodeId && node.implementation.contracts.filter(contract => contract.id === item.contractId).length === 1))) { setError({ key: 'selectionAmbiguous' }); return; }
        onChange(selections); setError(null);
      }}>{confirmed ? t('compile.confirmed') : t('compile.confirm')}</Button>
      {error && <p className="text-sm text-destructive" role="alert">{t(`compile.errors.${error.key}`)}</p>}
    </footer>
  </>;
}
