import { useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWorldStore } from '../store';
import { operationWorld, queryWorld, sameWorld } from '../store/client';
import type { ActionProposal, ApprovalBinding, ObjectView, Parameter, QueryArgument, QueryResult, Value, ValueType, WorldCommand, WorldRef } from '@/types/world';
import { DataTable, definitionName, Empty, Field, selectClass, TextField } from './components';
import { FixedRecord } from './Definitions';
import { useWorldConfirmation } from './WorldConfirmation';

type ActionStatus = Extract<QueryResult, { kind: 'action_status' }>['result'];

export function ValueField({ name, label, type, nullable = false, optional = false, objects, depth = 0 }: {
  name: string; label: string; type: ValueType; nullable?: boolean; optional?: boolean; objects: ObjectView[]; depth?: number;
}) {
  const { t } = useTranslation('world');
  const [mode, setMode] = useState('value');
  const [count, setCount] = useState(0);
  if (depth > 12) return <p className="text-sm text-destructive">{t('actions.field.depthLimit')}</p>;
  return <fieldset className="grid min-w-0 gap-2"><legend className="mb-2 text-sm font-medium">{label}</legend>
    {(nullable || optional) && <select aria-label={label} className={selectClass} name={`${name}.mode`} value={mode} onChange={event => setMode(event.target.value)}><option value="value">{t('actions.field.value')}</option>{nullable && <option value="null">{t('actions.field.null')}</option>}{optional && <option value="omit">{t('actions.field.omit')}</option>}</select>}
    {mode === 'value' && (type.kind === 'record' ? <div className="grid gap-3 border-l border-border pl-3">{type.fields.map(field => <ValueField key={field.name} name={`${name}.${field.name}`} label={field.name} type={field.valueType} nullable={field.nullable} optional={field.optional} objects={objects} depth={depth + 1} />)}</div>
      : type.kind === 'list' ? <div className="grid gap-3"><input type="hidden" name={`${name}.count`} value={count} />{Array.from({ length: count }, (_, index) => <ValueField key={index} name={`${name}.${index}`} label={t('actions.field.item', { count: index + 1 })} type={type.element} objects={objects} depth={depth + 1} />)}<div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={count >= Math.min(type.maxItems, 100)} onClick={() => setCount(count + 1)}>{t('actions.field.addItem')}</Button><Button type="button" size="sm" variant="outline" disabled={!count} onClick={() => setCount(count - 1)}>{t('actions.field.removeItem')}</Button></div>{type.maxItems > 100 && <p className="text-xs text-muted-foreground">{t('actions.field.listLimit', { count: 100 })}</p>}</div>
        : type.kind === 'boolean' ? <select aria-label={label} className={selectClass} name={name} required defaultValue=""><option value="">{t('actions.field.selectBoolean')}</option><option value="true">{t('actions.field.yes')}</option><option value="false">{t('actions.field.no')}</option></select>
          : type.kind === 'object' ? <select aria-label={label} className={selectClass} name={name} required defaultValue=""><option value="">{t('actions.field.selectObject')}</option>{objects.filter(item => item.object.typeId === type.typeId).map(item => <option value={item.object.id} key={item.object.id}>{item.object.id}</option>)}</select>
            : type.kind === 'null' ? <span className="text-sm text-muted-foreground">{t('actions.field.null')}</span>
              : <><Input aria-label={label} name={name} required type={type.kind === 'timestamp' ? 'datetime-local' : type.kind === 'date' ? 'date' : 'text'} inputMode={['integer', 'decimal', 'money', 'quantity', 'duration'].includes(type.kind) ? 'decimal' : undefined} maxLength={type.kind === 'text' ? type.maxLength : undefined} />{type.kind === 'money' && <span className="text-xs text-muted-foreground">{t('actions.field.currency', { currency: type.currency })}</span>}{type.kind === 'quantity' && <span className="text-xs text-muted-foreground">{t('actions.field.unit', { unit: type.unit.code })}</span>}{type.kind === 'duration' && <span className="text-xs text-muted-foreground">{t('actions.field.milliseconds')}</span>}{type.kind === 'relation' && <span className="text-xs text-muted-foreground">{t('actions.field.relationHint')}</span>}</>)}
  </fieldset>;
}

export function readValue(t: TFunction<'world'>, form: FormData, name: string, type: ValueType, nullable = false, optional = false, depth = 0): Value | undefined {
  if (depth > 12) throw new Error(t('actions.errors.depthLimit'));
  const mode = form.get(`${name}.mode`);
  if (mode === 'omit' && optional) return undefined;
  if (mode === 'null' && nullable) return { kind: 'null' };
  const text = String(form.get(name) ?? '');
  const decimal = () => { if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) throw new Error(t('actions.errors.decimal', { name })); return text; };
  switch (type.kind) {
    case 'null': return { kind: 'null' };
    case 'boolean': if (text !== 'true' && text !== 'false') throw new Error(t('actions.errors.boolean', { name })); return { kind: 'boolean', value: text === 'true' };
    case 'integer': if (!/^-?(0|[1-9]\d*)$/.test(text)) throw new Error(t('actions.errors.integer', { name })); return { kind: 'integer', value: text };
    case 'decimal': return { kind: 'decimal', value: decimal() };
    case 'money': return { kind: 'money', amount: decimal(), currency: type.currency };
    case 'quantity': return { kind: 'quantity', amount: decimal(), unit: type.unit };
    case 'text': if (text.length > type.maxLength) throw new Error(t('actions.errors.textLength', { name })); return { kind: 'text', value: text };
    case 'timestamp': if (!text || !Number.isFinite(Date.parse(text))) throw new Error(t('actions.errors.timestamp', { name })); return { kind: 'timestamp', value: new Date(text).toISOString() };
    case 'date': return { kind: 'date', calendar: type.calendar, value: text };
    case 'duration': if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error(t('actions.errors.duration', { name })); return { kind: 'duration', milliseconds: text };
    case 'object': if (!text) throw new Error(t('actions.errors.object', { name })); return { kind: 'object', id: text };
    case 'relation': if (!text.trim()) throw new Error(t('actions.errors.relation', { name })); return { kind: 'relation', id: text.trim() };
    case 'list': {
      const count = Number(form.get(`${name}.count`));
      if (!Number.isInteger(count) || count < 0 || count > Math.min(type.maxItems, 100)) throw new Error(t('actions.errors.listCount', { name }));
      return { kind: 'list', items: Array.from({ length: count }, (_, index) => readValue(t, form, `${name}.${index}`, type.element, false, false, depth + 1)!) };
    }
    case 'record': {
      const fields: Record<string, Value> = {};
      for (const field of type.fields) {
        const value = readValue(t, form, `${name}.${field.name}`, field.valueType, field.nullable, field.optional, depth + 1);
        if (value !== undefined) fields[field.name] = value;
      }
      return { kind: 'record', fields };
    }
  }
}

export function Actions({ target }: { target: ObjectView | null }) {
  const { t } = useTranslation('world');
  const confirm = useWorldConfirmation();
  const state = useWorldStore();
  const contracts = state.definitions.filter(item => item.body.kind === 'action_contract');
  const [composing, setComposing] = useState(false);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [actionId, setActionId] = useState('');
  const [proposalId, setProposalId] = useState('');
  const [approval, setApproval] = useState<ApprovalBinding | null>(null);
  const [approvalOperation, setApprovalOperation] = useState('');
  const [approvalUntil, setApprovalUntil] = useState('');
  const [operationId, setOperationId] = useState('');
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const mounted = useRef(false);
  const selection = useRef({ actionId, proposalId, approvalOperation, operationId, composing, reading, status, target });
  selection.current = { actionId, proposalId, approvalOperation, operationId, composing, reading, status, target };
  const version = useRef(0);
  useEffect(() => () => { version.current++; }, [actionId, proposalId, operationId, composing, status, target]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = (world: WorldRef, incarnation: string | undefined) => {
    const current = useWorldStore.getState();
    return mounted.current && current.world && sameWorld(current.world, world)
      && current.description?.incarnation === incarnation;
  };
  const definition = contracts.find(item => item.reference.id === actionId);
  const contract = definition?.body.kind === 'action_contract' ? definition.body.body : null;
  // A remembered click is not a current fact or read receipt after invalidation.
  const currentTarget = target && state.objects?.objects.find(item => item.object.id === target.object.id && sameWorld(item.object.world, target.object.world));
  const proposal = state.proposals.find(item => item.id === proposalId);
  const proposedDefinition = proposal && state.definitions.find(item => item.reference.id === proposal.request.action.id && item.reference.revision === proposal.request.action.revision);
  const proposedContract = proposedDefinition?.body.kind === 'action_contract' ? proposedDefinition.body.body : null;
  const submission = proposal && state.actionSubmissions.find(item => sameWorld(item.request.world, proposal.request.world)
    && item.request.proposalId === proposal.id && item.request.proposalDigest === proposal.digest);
  useEffect(() => { setComposing(false); setReceiptsOpen(false); setActionId(''); setProposalId(''); setApproval(null); setApprovalOperation(''); setOperationId(''); setStatus(null); setError(''); setReading(false); }, [state.world?.tenantId, state.world?.worldId]);
  useEffect(() => { setApproval(null); setApprovalOperation(''); setApprovalUntil(''); setReceiptsOpen(false); }, [proposalId, state.description?.incarnation]);
  const propose = async (form: HTMLFormElement) => {
    if (useWorldStore.getState().busy || !state.world || !definition || !contract) return;
    const world = state.world;
    const incarnation = state.description?.incarnation;
    const selected = actionId;
    setError('');
    try {
      const data = new FormData(form);
      const arguments_: QueryArgument[] = contract.parameters.flatMap((parameter: Parameter) => {
        const value = readValue(t, data, parameter.id, parameter.valueType, parameter.nullable, parameter.optional);
        return value === undefined ? [] : [{ parameterId: parameter.id, value }];
      });
      const targets = [...new Set(arguments_.flatMap(argument => argument.value.kind === 'object' ? [argument.value.id] : []))].map(id => ({ kind: 'object' as const, id }));
      if (contract.targets.length && !currentTarget) throw new Error(t('actions.errors.targetExpired'));
      const result = await state.command({ kind: 'action_propose', request: { world: state.world, action: definition.reference, arguments: arguments_, targets, basis: currentTarget ? [currentTarget.receiptId] : [], branchId: null } });
      if (isCurrent(world, incarnation) && selection.current.actionId === selected && result.kind === 'proposal') { setProposalId(result.result.id); setComposing(false); }
    } catch (error) { if (isCurrent(world, incarnation) && selection.current.actionId === selected) setError(error instanceof Error ? error.message : t('actions.errors.proposal')); }
  };
  const approve = async (proposal: ActionProposal) => {
    if (useWorldStore.getState().busy || !state.world) return;
    const world = state.world;
    const incarnation = state.description?.incarnation;
    setError('');
    try {
      const expiresAt = new Date(approvalUntil).toISOString();
      if (expiresAt > proposal.expiresAt) throw new Error(t('actions.errors.approvalExpiry'));
      const result = await state.command({ kind: 'action_approve', request: { proposalId: proposal.id, proposalDigest: proposal.digest, expiresAt } });
      if (!isCurrent(world, incarnation) || selection.current.proposalId !== proposal.id) return;
      if (result.kind === 'approval') setApproval(result.result);
      if (result.kind === 'accepted') setApprovalOperation(result.result.operationId);
    } catch (error) { if (isCurrent(world, incarnation) && selection.current.proposalId === proposal.id) setError(error instanceof Error ? error.message : t('actions.errors.approval')); }
  };
  const readApproval = async () => {
    if (reading || !state.world || !approvalOperation) return;
    const world = state.world;
    const incarnation = state.description?.incarnation;
    const selected = proposalId;
    setReading(true); setError('');
    try {
      const response = await operationWorld({ kind: 'result', request: { world, operationId: approvalOperation } });
      if (!isCurrent(world, incarnation) || selection.current.proposalId !== selected || selection.current.approvalOperation !== approvalOperation) return;
      if (response.kind !== 'result' || !sameWorld(response.result.accepted.world, world) || response.result.accepted.operationId !== approvalOperation) throw new Error(t('actions.errors.approvalMismatch'));
      if (response.result.result?.kind === 'approval') setApproval(response.result.result.result);
      else setError(response.result.failure?.message ?? t('actions.errors.approvalPending'));
    } catch (error) { if (isCurrent(world, incarnation) && selection.current.proposalId === selected && selection.current.approvalOperation === approvalOperation) setError(error instanceof Error ? error.message : t('actions.errors.readApproval')); }
    finally { if (mounted.current) setReading(false); }
  };
  const readStatus = async () => {
    if (reading || !state.world || !operationId.trim()) return;
    const world = state.world;
    const incarnation = state.description?.incarnation;
    const selected = operationId.trim();
    setReading(true); setStatus(null); setError('');
    try {
      const result = await queryWorld(world, { kind: 'action_status', request: { world, operationId: selected } }, 'action_status');
      if (!isCurrent(world, incarnation) || selection.current.operationId.trim() !== selected) return;
      if (result.operationId !== selected) throw new Error(t('actions.errors.statusMismatch'));
      setStatus(result);
    } catch (error) { if (isCurrent(world, incarnation) && selection.current.operationId.trim() === selected) setError(error instanceof Error ? error.message : t('actions.errors.readStatus')); }
    finally { if (mounted.current) setReading(false); }
  };
  const submit = async (proposal: ActionProposal) => {
    if (useWorldStore.getState().busy || !state.world || submission) return;
    const world = state.world;
    const incarnation = state.description?.incarnation;
    setError('');
    try {
      const result = await state.command({ kind: 'action_submit', request: { world, proposalId: proposal.id, proposalDigest: proposal.digest, idempotencyKey: crypto.randomUUID(), approval } });
      if (isCurrent(world, incarnation) && selection.current.proposalId === proposal.id && result.kind === 'accepted') { setOperationId(result.result.operationId); setStatus(null); }
    } catch (error) { if (isCurrent(world, incarnation) && selection.current.proposalId === proposal.id) setError(error instanceof Error ? error.message : t('actions.errors.submit')); }
  };
  const compensate = async () => {
    const world = state.world;
    const description = state.description;
    if (!world || !description || !status || operationId.trim() !== status.operationId || reading || composing) return;
    const read = version.current;
    const selected = selection.current;
    const basis = JSON.stringify([world, description.incarnation, description.revision, description.activeReleaseHead]);
    const command: WorldCommand = { kind: 'action_compensate', request: { world, operationId: status.operationId } };
    const current = () => {
      const latest = useWorldStore.getState();
      return read === version.current && isCurrent(world, description.incarnation)
        && selection.current.actionId === selected.actionId && selection.current.proposalId === selected.proposalId
        && selection.current.operationId === selected.operationId && selection.current.status === status
        && selection.current.target === target && !selection.current.reading && !selection.current.composing
        && latest.description && sameWorld(latest.description.world, world) && latest.description.status === 'ready'
        && JSON.stringify([latest.world, latest.description.incarnation, latest.description.revision, latest.description.activeReleaseHead]) === basis
        && !latest.loading && !latest.busy && !latest.operationBusy && !latest.pending && !latest.pendingOperation && !latest.transferBusy;
    };
    if (!current() || !await confirm(t('actions.compensateConfirm')) || !current()) return;
    void useWorldStore.getState().command(command).catch(() => undefined);
  };
  const summaryDefinition = composing ? definition : proposedDefinition;
  const summaryContract = composing ? contract : proposedContract;
  const pendingRequest = state.pending?.request;
  const pendingSubmission = proposal && pendingRequest?.command.kind === 'action_submit'
    && sameWorld(pendingRequest.world, proposal.request.world)
    && pendingRequest.command.request.proposalId === proposal.id
    && pendingRequest.command.request.proposalDigest === proposal.digest ? pendingRequest : null;
  const idempotencyLabels = {
    source_key: 'atelier.actions.idempotencySource', conditional_write: 'atelier.actions.idempotencyConditional',
    inspect_before_retry: 'atelier.actions.idempotencyInspect', no_automatic_retry: 'atelier.actions.idempotencyNever',
  } as const;
  return <div className="world-atelier-content space-y-5">
    <header className="world-heading">
      <h2 className="text-base font-semibold">{t('actions.title')}</h2>
      {!composing && <Button size="sm" disabled={!state.world || !contracts.length} onClick={() => { setActionId(''); setProposalId(''); setComposing(true); setOperationId(''); setStatus(null); setReceiptsOpen(false); }}>{t('actions.start')}</Button>}
    </header>
    {error && <p className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive" role="alert">{error}</p>}
    <div className="world-settings-layout">
      <div className="min-w-0 space-y-5">
        <section className="world-panel">
          <details open={!composing && !proposal && !operationId}>
            <summary className="cursor-pointer px-5 py-4 text-sm font-semibold">{t('actions.proposal.id')} · {state.proposals.length}</summary>
            <DataTable columns={[t('actions.action'), t('actions.proposal.expires'), t('actions.proposal.details')]} rows={state.proposals.map(item => {
              const action = state.definitions.find(definition => definition.reference.id === item.request.action.id && definition.reference.revision === item.request.action.revision);
              return [<span><span className="block font-medium">{action ? definitionName(action) : item.request.action.id}</span><span className="mt-1 block break-all font-mono text-xs text-muted-foreground">{item.id}</span></span>, new Date(item.expiresAt).toLocaleString(), <button type="button" aria-pressed={!composing && proposalId === item.id} className="text-xs underline underline-offset-4" onClick={() => { setProposalId(item.id); setActionId(''); setComposing(false); setOperationId(''); setStatus(null); setReceiptsOpen(false); }}>{t('actions.proposal.details')}</button>];
            })} empty={t('actions.proposal.empty')} />
          </details>
          <details className="border-t border-[hsl(var(--shell-border))] px-5 py-4">
            <summary className="cursor-pointer text-sm font-medium">{t('actions.byNumber')}</summary>
            <form className="mt-4 flex min-w-0 flex-wrap items-end gap-3 [&>label]:flex-1" onSubmit={event => { event.preventDefault(); setComposing(false); setProposalId(''); void readStatus(); }}>
              <TextField label={t('actions.operationId')} value={operationId} onChange={value => { setOperationId(value); setStatus(null); }} />
              <Button size="sm" variant="outline" disabled={!state.world || !operationId.trim() || reading}>{t('actions.readStatus')}</Button>
            </form>
          </details>
        </section>
        <section className="world-panel min-w-0 [overflow-wrap:anywhere]">
        <header className="world-panel-header">
          <h3 className="min-w-0 text-base font-semibold">{summaryDefinition ? definitionName(summaryDefinition) : composing ? t('actions.start') : t('actions.progress')}</h3>
          {composing ? <Button size="sm" variant="ghost" onClick={() => { setComposing(false); setActionId(''); }}>{t('actions.cancel')}</Button> : (proposal || operationId) && <Button size="sm" variant="ghost" onClick={() => { setProposalId(''); setOperationId(''); setStatus(null); setReceiptsOpen(false); }}>{t('actions.collapse')}</Button>}
        </header>
        <div className="world-panel-body space-y-6">
          {summaryContract && <dl className="flex flex-wrap gap-x-6 gap-y-3 border-b border-[hsl(var(--shell-border))] pb-4 text-sm">
            <div><dt className="text-xs text-muted-foreground">{t('actions.riskLabel')}</dt><dd className="mt-1">{t(`actions.risk.${summaryContract.risk}`)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('actions.approvalLabel')}</dt><dd className="mt-1">{t(`actions.approval.${summaryContract.approval}`)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('atelier.actions.idempotency')}</dt><dd className="mt-1">{t(idempotencyLabels[summaryContract.idempotency])}</dd></div>
          </dl>}
          {(composing || !proposal) && <div className="space-y-2"><p className="text-sm">{currentTarget ? t('actions.currentTarget', { id: currentTarget.object.id }) : t('atelier.actions.noTarget')}</p>{currentTarget && <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('data.readReceipt')}</summary><p className="mt-2 break-all font-mono text-xs">{currentTarget.receiptId}</p></details>}</div>}
          {composing ? <section className="space-y-4">
            {target && !currentTarget && <p className="text-sm text-destructive" role="alert">{t('actions.errors.targetExpired')}</p>}
            <form className="grid min-w-0 gap-5" key={`${actionId}:${state.description?.incarnation ?? ''}`} onSubmit={event => { event.preventDefault(); void propose(event.currentTarget); }}>
              <Field label={t('actions.action')}><select className={selectClass} value={actionId} required onChange={event => setActionId(event.target.value)}><option value="">{t('actions.selectAction')}</option>{contracts.map(item => <option key={item.reference.id} value={item.reference.id}>{definitionName(item)} · {item.reference.revision}</option>)}</select></Field>
              {contract && <>
                <fieldset className="grid min-w-0 gap-4">
                  <legend className="mb-3 text-sm font-medium">{t('model.content.parameters')}</legend>
                  {contract.parameters.map(parameter => <div key={parameter.id} className="min-w-0 rounded-lg border border-[hsl(var(--shell-border))] p-4">
                    <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{t(`model.valueTypes.${parameter.valueType.kind}`)}</span>{parameter.optional && <span>{t('model.content.optional')}</span>}{parameter.nullable && <span>{t('model.content.nullable')}</span>}</div>
                    <ValueField name={parameter.id} label={parameter.id} type={parameter.valueType} nullable={parameter.nullable} optional={parameter.optional} objects={state.objects?.objects ?? []} />
                  </div>)}
                  {!contract.parameters.length && <p className="text-sm text-muted-foreground">{t('atelier.actions.noParameters')}</p>}
                </fieldset>
                <div className="border-t border-[hsl(var(--shell-border))] pt-4"><Button size="sm" disabled={state.busy || !state.world || (contract.targets.length > 0 && !currentTarget)}>{t('actions.createProposal')}</Button></div>
              </>}
              {!contracts.length && <Empty>{t('actions.noActions')}</Empty>}
            </form>
          </section> : <>
            {proposal ? <>
              <section className="space-y-4">
                <h4 className="text-sm font-semibold">{t('atelier.actions.preview')}</h4>
                <p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.actions.previewHint')}</p>
                <dl className="grid gap-4 rounded-lg border border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface-muted))] p-4 text-sm">
                  <div className="space-y-1"><dt className="text-xs text-muted-foreground">{t('actions.proposal.conditions')}</dt><dd>{proposal.preconditions.map(value => t(`actions.truth.${value}`)).join(' · ') || t('actions.proposal.noConditions')}</dd></div>
                  <div className="space-y-1"><dt className="text-xs text-muted-foreground">{t('actions.proposal.expires')}</dt><dd>{new Date(proposal.expiresAt).toLocaleString()}</dd></div>
                </dl>
                <div><h5 className="mb-2 text-sm font-medium">{t('actions.proposal.targets')}</h5><FixedRecord value={proposal.request.targets} /></div>
                <div><h5 className="mb-2 text-sm font-medium">{t('actions.proposal.arguments')}</h5><FixedRecord value={proposal.request.arguments} /></div>
                <details className="border-t border-[hsl(var(--shell-border))] pt-4"><summary className="cursor-pointer text-sm font-medium">{t('actions.proposal.impact')}</summary><div className="mt-3"><FixedRecord value={proposal.impact} /></div></details>
              </section>
              <section className="space-y-4 border-t border-[hsl(var(--shell-border))] pt-5">
                <h4 className="text-sm font-semibold">{t('atelier.actions.approval')}</h4>
                <p className="text-sm leading-relaxed text-muted-foreground">{t('atelier.actions.approvalHint')}</p>
                {proposedContract?.approval === 'none' ? <p className="text-sm text-muted-foreground">{t('atelier.actions.noApproval')}</p> : <div className="grid min-w-0 gap-3">
                  <TextField label={t('actions.proposal.approvalUntil')} type="datetime-local" value={approvalUntil} onChange={setApprovalUntil} />
                  <div><Button size="sm" variant="outline" disabled={state.busy || !approvalUntil || !proposedContract} onClick={() => { void approve(proposal); }}>{t('actions.proposal.approve')}</Button></div>
                  {approvalOperation && <div className="space-y-2"><p className="text-xs text-muted-foreground">{t('actions.operationId')} · {approvalOperation}</p><Button size="sm" variant="outline" disabled={reading} onClick={() => { void readApproval(); }}>{t('actions.proposal.checkApproval')}</Button></div>}
                </div>}
                {approval && <div className="space-y-3 rounded-lg border border-[hsl(var(--shell-border))] p-3"><p className="text-sm" role="status">{t('actions.proposal.approved', { id: approval.approvalId, expires: new Date(approval.expiresAt).toLocaleString() })}</p><details><summary className="cursor-pointer text-xs text-muted-foreground">{t('shell.diagnostic')}</summary><div className="mt-3"><FixedRecord value={approval} /></div></details></div>}
              </section>
            </> : !operationId && <Empty>{t('atelier.actions.selectHint')}</Empty>}
            {(proposal || operationId) && <section className="space-y-4 border-t border-[hsl(var(--shell-border))] pt-5">
              <h4 className="text-sm font-semibold">{t('atelier.actions.execution')}</h4>
              {proposal && <div className="space-y-3">
                <Button size="sm" disabled={state.busy || !state.world || !!submission || !proposedContract || (proposedContract.approval !== 'none' && !approval) || Date.parse(proposal.expiresAt) <= Date.now() || proposal.preconditions.some(value => value !== 'true')} onClick={() => { void submit(proposal); }}>{t('actions.proposal.submit')}</Button>
                {submission && <p className="text-sm">{t('actions.proposal.submitted')} <button type="button" className="break-all font-mono underline underline-offset-4" onClick={() => { setOperationId(submission.operation.operationId); setStatus(null); }}>{submission.operation.operationId}</button></p>}
                <p className="text-sm text-muted-foreground">{t('actions.proposal.unknownHint')}</p>
              </div>}
              {operationId && <div className="space-y-4 rounded-lg border border-[hsl(var(--shell-border))] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3"><h5 className="text-sm font-medium">{t('actions.progress')}</h5><Button size="sm" variant="outline" disabled={!state.world || reading} onClick={() => { void readStatus(); }}>{t('actions.refreshStatus')}</Button></div>
                <p className="break-all font-mono text-xs text-muted-foreground">{operationId}</p>
                {status ? <>
                  <p className="text-sm font-semibold" role="status">{t(`actions.phase.${status.phase}`)}</p>
                  {(status.phase === 'effect_indeterminate' || status.phase === 'commit_indeterminate') && <p className="text-sm text-muted-foreground">{t('actions.proposal.unknownHint')}</p>}
                  {status.failure && <div className="space-y-3"><p className="text-sm text-destructive" role="alert">{status.failure.message} · {status.failure.diagnosticId}</p><details><summary className="cursor-pointer text-sm">{t('shell.diagnostic')}</summary><div className="mt-3"><FixedRecord value={status.failure} /></div></details></div>}
                  <div className="space-y-4 border-t border-[hsl(var(--shell-border))] pt-4">
                    <div className="flex flex-wrap items-center justify-between gap-3"><h5 className="text-sm font-medium">{t('actions.receiptsTitle')}</h5><Button size="sm" variant="outline" aria-expanded={receiptsOpen} onClick={() => setReceiptsOpen(!receiptsOpen)}>{receiptsOpen ? t('actions.collapse') : t('connections.viewDetails')}</Button></div>
                    {receiptsOpen && <div className="space-y-5">
                      <DataTable columns={[t('actions.receipts.source'), t('actions.receipts.effect'), t('actions.receipts.observedAt')]} rows={status.sourceReceipts.map(item => [item.sourceId, t(`actions.effect.${item.disposition}`), new Date(item.observedAt).toLocaleString()])} empty={t('actions.receipts.noSource')} />
                      <DataTable columns={[t('actions.receipts.verification'), t('actions.receipts.verdict'), t('actions.receipts.verifiedAt')]} rows={status.verifications.map(item => [item.id, t(`actions.verdict.${item.verdict}`), new Date(item.verifiedAt).toLocaleString()])} empty={t('actions.receipts.noVerification')} />
                      {status.commit && <div className="space-y-3"><h5 className="text-sm font-medium">{t('atelier.actions.commit')}</h5><FixedRecord value={status.commit} /></div>}
                    </div>}
                  </div>
                  <details className="border-t border-[hsl(var(--shell-border))] pt-4">
                    <summary className="cursor-pointer text-sm font-medium">{t('actions.operationDetails')}</summary>
                    <div className="mt-4 space-y-4"><p className="text-xs text-muted-foreground">{t('actions.run', { id: status.runId })}</p><FixedRecord value={status} /><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={state.busy || !state.world} onClick={() => { if (state.world) void state.command({ kind: 'action_reconcile', request: { world: state.world, operationId: status.operationId } }).catch(() => undefined); }}>{t('actions.reconcile')}</Button><Button size="sm" variant="outline" disabled={state.busy || !state.world} onClick={() => { void compensate(); }}>{t('actions.compensate')}</Button></div></div>
                  </details>
                </> : <p className="text-sm text-muted-foreground">{reading ? t('shell.processing') : t('atelier.actions.notRead')}</p>}
              </div>}
            </section>}
          </>}
          {!composing && !proposal && target && !currentTarget && <p className="text-sm text-destructive" role="alert">{t('actions.errors.targetExpired')}</p>}
          {(summaryDefinition || proposal) && <details className="border-t border-[hsl(var(--shell-border))] pt-4">
            <summary className="cursor-pointer text-sm font-medium">{t('atelier.actions.contract')} · {t('atelier.actions.requestIdentity')}</summary>
            <div className="mt-4 space-y-4">
              {summaryDefinition && <FixedRecord value={summaryDefinition.reference} />}
              {summaryContract && <FixedRecord value={summaryContract} />}
              {proposal && <><FixedRecord value={{ id: proposal.id, digest: proposal.digest, request: proposal.request, readDependencies: proposal.readDependencies, activationLockId: proposal.activationLockId }} />
                {(submission || pendingSubmission) && <section className="space-y-3 border-t border-[hsl(var(--shell-border))] pt-3"><h4 className="text-sm font-medium">{t('atelier.actions.requestIdentity')}</h4>{pendingSubmission && <p className="text-sm text-muted-foreground">{t('shell.pendingRequest')}</p>}<FixedRecord value={submission ? submission.request : pendingSubmission} /></section>}
              </>}
            </div>
          </details>}
        </div>
        </section>
      </div>
      <aside className="world-panel min-w-0">
        <header className="world-panel-header"><h3 className="text-sm font-semibold">{t('atelier.actions.flow')}</h3></header>
        <div className="world-panel-body space-y-5">
          <ol className="world-trace text-sm">
            <li><span className="font-medium">{t('atelier.actions.configure')} · {t('atelier.actions.preview')}</span></li>
            <li><span className="font-medium">{t('atelier.actions.approval')}</span></li>
            <li><span className="font-medium">{t('atelier.actions.execution')}</span></li>
          </ol>
          <p className="border-t border-[hsl(var(--shell-border))] pt-4 text-xs leading-relaxed text-muted-foreground">{t('atelier.actions.receiptHint')}</p>
        </div>
      </aside>
    </div>
  </div>;
}
