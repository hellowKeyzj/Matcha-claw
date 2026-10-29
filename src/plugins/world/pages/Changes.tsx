import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, FileText, GitCompareArrows, Shield } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWorldStore } from '../store';
import { queryWorld, sameWorld } from '../store/client';
import type { AcceptanceCriterion, Budget, ChangeSet, CompileRequest, CompileSelection, Definition, DefinitionRef, EvaluationMetric, FreezeSuite, FrozenPlan, FrozenSuite, PlanSelection, QueryResult, ReadMode, ReleaseView, SemanticOperation, SuiteCreationContext, TaskSummary, TestCase, TestRevision, WorldCommand, WorldRef } from '@/types/world';
import { DataTable, definitionName, Empty, Field, Section, selectClass, TextField } from './components';
import { DefinitionDetails, FixedRecord } from './Definitions';
import { BudgetFields } from './Materials';
import { CompileSelectionFields } from './CompileSelection';
import { useWorldConfirmation } from './WorldConfirmation';

type EvaluationReport = Extract<QueryResult, { kind: 'evaluation' }>['result'];
function target(operation: SemanticOperation): string {
  if ('previous' in operation) return operation.previous.id;
  if ('target' in operation) return 'id' in operation.target ? operation.target.id : operation.target.kind;
  if ('definition' in operation) return operation.definition.reference.id;
  return 'reason' in operation ? operation.reason : '—';
}

function DefinitionSnapshot({ definition }: { definition: Definition }) {
  const { t } = useTranslation('world');
  return <div className="min-w-0 space-y-4"><div><p className="font-medium">{definitionName(definition)}</p><p className="mt-1 break-all text-xs text-muted-foreground">{definition.reference.id} · {definition.reference.revision}</p><p className="mt-1 text-xs text-muted-foreground">{t(`model.kinds.${definition.body.kind}`)}</p></div><DefinitionDetails definition={definition} /></div>;
}

function ExactDefinition({ reference }: { reference: DefinitionRef }) {
  const definitions = useWorldStore(state => state.definitions);
  const cached = definitions.find(item => item.reference.id === reference.id && item.reference.revision === reference.revision && sameWorld(item.reference.world, reference.world));
  return cached ? <DefinitionSnapshot definition={cached} /> : <ReadDefinition key={JSON.stringify(reference)} reference={reference} />;
}

function ReadDefinition({ reference }: { reference: DefinitionRef }) {
  const { t } = useTranslation('world');
  const [definition, setDefinition] = useState<Definition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    void queryWorld(reference.world, { kind: 'definition', request: { reference } }, 'definition').then(value => {
      if (!current) return;
      if (value && (!sameWorld(value.reference.world, reference.world) || value.reference.id !== reference.id || value.reference.revision !== reference.revision)) throw new Error(t('atelier.review.definitionMismatch'));
      setDefinition(value); setError('');
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : t('atelier.review.definitionReadError')); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [reference, t]);
  return <div className="min-w-0 space-y-3">{loading ? <p className="text-sm text-muted-foreground" role="status">{t('changes.loading')}</p> : error ? <p className="text-sm text-destructive" role="alert">{error}</p> : definition ? <DefinitionSnapshot definition={definition} /> : <p className="text-sm text-muted-foreground">{t('atelier.review.definitionUnavailable')}</p>}</div>;
}

function SemanticDifference({ operation }: { operation: SemanticOperation }) {
  const { t } = useTranslation('world');
  const reference = (value: { id: string; revision: string }) => `${value.id} · ${value.revision}`;
  const exact = (value: DefinitionRef) => <div key={JSON.stringify(value)} className="space-y-3"><p className="break-all font-mono text-xs text-muted-foreground">{reference(value)}</p><ExactDefinition reference={value} /></div>;
  let before: ReactNode;
  let after: ReactNode;
  switch (operation.kind) {
    case 'no_op': before = <p>{t('changes.operations.no_op')}</p>; after = <p>{operation.reason}</p>; break;
    case 'attach_evidence':
      before = <p className="text-muted-foreground">{t('atelier.review.previousEvidenceUnavailable')}</p>;
      after = <ul className="space-y-2">{operation.evidence.map(item => <li key={JSON.stringify(item)} className="break-all">{reference(item)}</li>)}</ul>; break;
    case 'enrich_annotation':
      before = <div className="space-y-4">{exact(operation.target)}<p className="text-xs text-muted-foreground">{t('atelier.review.previousAnnotationsUnavailable')}</p></div>;
      after = <dl className="space-y-4">{operation.annotation.label != null && <div><dt className="text-xs text-muted-foreground">{t('model.edit.name')}</dt><dd className="mt-1 font-medium">{operation.annotation.label === '' ? '""' : operation.annotation.label}</dd></div>}{operation.annotation.description != null && <div><dt className="text-xs text-muted-foreground">{t('model.edit.description')}</dt><dd className="mt-1 whitespace-pre-wrap">{operation.annotation.description === '' ? '""' : operation.annotation.description}</dd></div>}{operation.annotation.aliases.length > 0 && <div><dt className="text-xs text-muted-foreground">{t('model.edit.aliases')}</dt><dd className="mt-1">{operation.annotation.aliases.join(', ')}</dd></div>}</dl>; break;
    case 'refine_definition':
    case 'supersede_rule': before = exact(operation.previous); after = <DefinitionSnapshot definition={operation.replacement} />; break;
    case 'scope_definition':
      before = exact(operation.previous);
      after = <dl className="space-y-4"><div><dt className="text-xs text-muted-foreground">{t('model.details.scope')}</dt><dd className="mt-1 font-medium">{operation.scope}</dd></div><div><dt className="text-xs text-muted-foreground">{t('model.details.validTime')}</dt><dd className="mt-1">{operation.validTime.from} / {operation.validTime.to ?? t('model.details.ongoing')}</dd></div></dl>; break;
    case 'link_existing':
      before = <div className="space-y-5"><p className="text-xs text-muted-foreground">{t('atelier.review.previousLinksUnavailable')}</p>{exact(operation.source)}{exact(operation.target)}</div>;
      after = <div className="space-y-3"><p className="font-medium">{t(`changes.links.${operation.relation}`)}</p><p>{reference(operation.source)} → {reference(operation.target)}</p></div>; break;
    case 'merge_aliases':
      before = <div className="space-y-5">{operation.sources.map(exact)}</div>;
      after = <div className="space-y-4"><p className="text-xs text-muted-foreground">{t('atelier.review.aliasIdentityHint')}</p>{exact(operation.target)}<p className="text-xs text-muted-foreground">{t('changes.evidence')}</p><ul className="space-y-2">{operation.evidence.map(item => <li key={JSON.stringify(item)} className="break-all">{reference(item)}</li>)}</ul></div>; break;
    case 'deprecate_definition':
      before = exact(operation.previous);
      after = <div className="space-y-4"><p className="font-medium">{t('changes.operations.deprecate_definition')}</p><p>{operation.reason}</p><p>{t('model.edit.effectiveAt')}<br />{operation.effectiveAt}</p>{operation.replacements.length > 0 && <div><p className="mb-2 text-xs text-muted-foreground">{t('changes.diff.replacements')}</p>{operation.replacements.map(exact)}</div>}</div>; break;
    case 'split_definition':
      before = exact(operation.previous);
      after = <div className="space-y-6">{operation.replacements.map(definition => <div key={JSON.stringify(definition.reference)} className="space-y-4"><DefinitionSnapshot definition={definition} /><details><summary className="cursor-pointer text-xs text-muted-foreground">{t('model.content.condition')}</summary><div className="mt-3"><FixedRecord value={operation.partition.filter(item => item.replacement === definition.reference.id).map(item => item.predicate)} /></div></details></div>)}</div>; break;
    case 'create_definition': before = <p className="text-muted-foreground">{t('atelier.review.noPreviousDefinition')}</p>; after = <DefinitionSnapshot definition={operation.definition} />; break;
  }
  return <section className="space-y-3 border-b border-border/70 py-5 last:border-0"><div><h3 className="text-sm font-medium">{t(`changes.operations.${operation.kind}`)}</h3><p className="mt-1 break-words font-mono text-xs text-muted-foreground">{target(operation)}</p></div><div className="world-semantic-diff"><section className="min-w-0 overflow-hidden rounded-lg border border-border"><h4 className="border-b border-border bg-[hsl(var(--shell-surface-muted))] px-4 py-3 text-xs font-medium text-muted-foreground">{t('atelier.review.before')}</h4><div className="space-y-4 break-words p-4 text-sm leading-relaxed">{before}</div></section><section className="min-w-0 overflow-hidden rounded-lg border border-ring/30"><h4 className="border-b border-ring/20 bg-accent/20 px-4 py-3 text-xs font-medium">{t('atelier.review.after')}</h4><div className="space-y-4 break-words p-4 text-sm leading-relaxed">{after}</div></section></div><details><summary className="cursor-pointer text-xs text-muted-foreground">{t('changes.review.rawOperation')}</summary><div className="mt-3 space-y-3"><p className="text-xs text-muted-foreground">{t('atelier.review.operationRecord')}</p><FixedRecord value={operation} /></div></details></section>;
}

export function EvaluationReportView({ report }: { report: EvaluationReport }) {
  const { t } = useTranslation('world');
  return <div className="space-y-4">
    <p className="text-sm">{t(`changes.execution.${report.execution.kind}`)} · {t(`changes.verdict.${report.verdict}`)} · {t('changes.report.coverageValue', { tested: report.coverage.tested, total: report.coverage.total })}</p>
    <p className="text-xs text-muted-foreground">{t(report.assurance === 'tested' ? 'changes.report.tested' : 'changes.report.untested')}</p>
    {report.execution.kind === 'failed' && <p className="text-sm text-destructive" role="alert">{report.execution.failure.message}</p>}
    <DataTable columns={[t('changes.report.hardCheck'), t('changes.result'), t('changes.evidence')]} rows={report.hardChecks.map(item => [item.name, t(item.passed ? 'changes.passed' : 'changes.notPassed'), item.evidence.map(reference => reference.id).join(', ')])} empty={t('changes.report.noHardChecks')} />
    <DataTable columns={[t('changes.arm'), t('changes.metrics.success'), t('changes.report.latency'), t('changes.report.origin'), t('changes.split')]} rows={report.arms.map(item => [t(`changes.arms.${item.arm.kind}`), item.success, item.fullLatency, t(`changes.origins.${item.origin}`), t(`changes.splits.${item.split}`)])} empty={t('changes.report.noArms')} />
    <DataTable columns={[t('changes.report.metric'), t('changes.report.estimate'), t('changes.report.interval'), t('changes.report.sampleSize')]} rows={report.estimates.map(item => [t(`changes.metrics.${item.metric}`), item.estimate, `${item.lower ?? t('changes.unknown')} — ${item.upper ?? t('changes.unknown')}`, item.sampleSize])} empty={t('changes.report.noEstimates')} />
    <DataTable columns={[t('changes.test'), t('changes.arm'), t('changes.executionLabel'), t('changes.report.oracle')]} rows={report.cases.map(item => [item.test.id, t(`changes.arms.${item.arm.kind}`), t(`changes.execution.${item.execution.kind}`), item.oraclePassed == null ? t('changes.report.noOracle') : t(item.oraclePassed ? 'changes.passed' : 'changes.notPassed')])} empty={t('changes.report.noCases')} />
    <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">{t('changes.report.metadata')}</summary><div className="mt-3"><DataTable columns={[t('changes.report.info'), t('changes.result')]} rows={[
      [t('changes.report.id'), report.id], [t('changes.report.candidate'), report.candidateId], [t('changes.suite'), `${report.suiteId} · ${report.suiteRevision}`],
      [t('changes.report.assumptions'), t(report.coverage.assumptionsUsed ? 'changes.yes' : 'changes.no')],
      [t('changes.report.missingSources'), report.coverage.missingSources.join(', ') || t('changes.report.noRecordedGaps')],
      [t('changes.report.missingTests'), report.coverage.missingTests.map(item => `${item.id} · ${item.revision}`).join(', ') || t('changes.report.noRecordedGaps')],
    ]} /></div></details>
    <p className="text-xs text-muted-foreground">{t('changes.report.limit')}</p>
  </div>;
}

function RecordTestForm({ task, template, context }: { task: TaskSummary; template: TestCase | null; context: SuiteCreationContext | null }) {
  const { t } = useTranslation('world');
  const state = useWorldStore();
  const [id, setId] = useState('');
  const [nextRevision, setNextRevision] = useState(false);
  const [originFamily, setOriginFamily] = useState('');
  const [purpose, setPurpose] = useState<TestCase['purpose']>(template?.purpose ?? 'regression');
  const [split, setSplit] = useState<TestCase['split'] | ''>(template?.split ?? '');
  const [protectedTest, setProtectedTest] = useState(template?.protected ?? false);
  const [occurredAt, setOccurredAt] = useState('');
  const [fixture, setFixture] = useState<File | null>(null);
  const [expected, setExpected] = useState<File | null>(null);
  const [error, setError] = useState('');
  const matching = template && template.taskId === task.reference.id && template.taskRevision === task.reference.revision && sameWorld(template.world, task.reference.world);
  const fresh = !template && context?.task.id === task.reference.id && context.task.revision === task.reference.revision && sameWorld(context.task.world, task.reference.world) ? context.task : null;
  return <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">{t('changes.record.title')}</summary><form className="mt-4 grid max-w-3xl gap-4" onSubmit={event => {
    event.preventDefault();
    if (useWorldStore.getState().busy || (!matching && !fresh) || !fixture || !expected || !split || !occurredAt) return;
    try {
      const revision = nextRevision && template ? String(BigInt(template.revision) + 1n) : '1';
      const testId = nextRevision && template ? template.id : id.trim();
      if (!testId || (nextRevision && (!template || template.protected || template.split === 'holdout'))) throw new Error(t('changes.record.protectedError'));
      const source = matching && template ? template : fresh ? { world: fresh.world, taskId: fresh.id, taskRevision: fresh.revision, scope: fresh.scope, oracle: fresh.successOracle, originFamily: originFamily.trim(), evidence: [], caseId: null, candidateId: null } : null;
      if (!source?.originFamily) throw new Error(t('changes.record.originError'));
      setError('');
      void state.recordTestCase({ ...source, id: testId, revision, purpose, split, protected: protectedTest || purpose === 'counterexample' || split === 'holdout', occurredAt: new Date(occurredAt).toISOString() }, fixture, expected).catch(error => setError(error instanceof Error ? error.message : t('changes.record.unknown')));
    } catch (error) { setError(error instanceof Error ? error.message : t('changes.record.invalid')); }
  }}><p className="text-xs text-muted-foreground">{t('changes.record.hint')}</p>
    {(matching && template) || fresh ? <>
      <details><summary className="cursor-pointer text-sm">{t('changes.record.basis')}</summary><div className="mt-3"><FixedRecord value={matching && template ? { task: task.reference, oracle: template.oracle, originFamily: template.originFamily, evidence: template.evidence, caseId: template.caseId, candidateId: template.candidateId } : { task: task.reference, oracle: fresh?.successOracle, requiredSuites: fresh?.requiredSuites }} /></div></details>
      {matching && template ? <Field label={t('changes.record.mode')}><select className={selectClass} value={nextRevision ? 'revision' : 'new'} onChange={event => setNextRevision(event.target.value === 'revision')}><option value="new">{t('changes.record.newTest')}</option><option value="revision" disabled={template.protected || template.split === 'holdout'}>{t('changes.record.nextRevision')}</option></select></Field> : <TextField label={t('changes.record.originFamily')} value={originFamily} onChange={setOriginFamily} />}
      {nextRevision && template ? <p className="text-sm">{t('changes.record.revisionValue', { id: template.id, revision: String(BigInt(template.revision) + 1n) })}</p> : <TextField label={t('changes.record.id')} value={id} onChange={setId} />}
      <div className="grid gap-3 sm:grid-cols-2"><Field label={t('changes.record.purpose')}><select className={selectClass} value={purpose} onChange={event => setPurpose(event.target.value as TestCase['purpose'])}><option value="regression">{t('changes.record.regression')}</option><option value="counterexample">{t('changes.record.counterexample')}</option><option value="boundary">{t('changes.record.boundary')}</option></select></Field><Field label={t('changes.split')}><select required className={selectClass} value={split} onChange={event => setSplit(event.target.value as TestCase['split'])}><option value="">{t('changes.record.chooseSplit')}</option><option value="train">{t('changes.splits.train')}</option><option value="dev">{t('changes.splits.dev')}</option><option value="holdout">{t('changes.record.protectedHoldout')}</option></select></Field><TextField label={t('changes.record.occurredAt')} type="datetime-local" value={occurredAt} onChange={setOccurredAt} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={protectedTest || purpose === 'counterexample' || split === 'holdout'} disabled={purpose === 'counterexample' || split === 'holdout'} onChange={event => setProtectedTest(event.target.checked)} />{t('changes.record.protect')}</label><Field label={t('changes.record.input')}><input required type="file" onChange={event => setFixture(event.target.files?.[0] ?? null)} /></Field><Field label={t('changes.record.expected')}><input required type="file" onChange={event => setExpected(event.target.files?.[0] ?? null)} /></Field></div><div><Button size="sm" disabled={state.busy || !fixture?.size || !expected?.size || !split || !occurredAt || (!nextRevision && !id.trim()) || (Boolean(fresh) && !originFamily.trim())}>{t('changes.record.submit')}</Button></div>
    </> : <Empty>{t('changes.record.empty')}</Empty>}
    {state.upload && state.busy && <p className="text-sm" role="status">{state.upload.name} · {state.upload.state} · {state.upload.received} / {state.upload.total} <button type="button" className="underline" onClick={state.cancelUpload}>{t('changes.cancel')}</button></p>}{error && <p className="text-sm text-destructive" role="alert">{error}</p>}
  </form></details>;
}

const evaluationMetrics: EvaluationMetric[] = ['success', 'regression', 'dangerous_effects', 'error_merge', 'evidence_coverage', 'conflict', 'retraction_lag', 'active_complexity', 'migration_cost', 'tokens', 'cost', 'full_latency'];
const evaluationArms: PlanSelection['arm'][] = [{ kind: 'candidate' }, { kind: 'tool_memory' }, { kind: 'static_ontology' }, { kind: 'append_only' }];

function validFrozenPlan(value: unknown, world: WorldRef, arm: PlanSelection['arm']): value is FrozenPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as FrozenPlan;
  const validReference = (reference: DefinitionRef) => Boolean(reference?.world && sameWorld(reference.world, world)
    && typeof reference.id === 'string' && reference.id.trim()
    && typeof reference.revision === 'string' && /^[1-9]\d*$/.test(reference.revision));
  if (!validReference(plan.strategy) || !Array.isArray(plan.tools) || !plan.tools.every(validReference)
    || !Array.isArray(plan.definitions) || !plan.definitions.length
    || !plan.definitions.every(definition => validReference(definition?.reference) && definition.body && typeof definition.body.kind === 'string')
    || !Array.isArray(plan.scopes) || !plan.scopes.every(scope => scope?.world && sameWorld(scope.world, world)
      && typeof scope.id === 'string' && scope.id.trim() && scope.predicate && typeof scope.predicate.kind === 'string')
    || !plan.knowledge || plan.knowledge.kind !== arm.kind) return false;
  switch (plan.knowledge.kind) {
    case 'tool_memory': return Boolean(plan.knowledge.snapshot?.world && sameWorld(plan.knowledge.snapshot.world, world)
      && typeof plan.knowledge.snapshot.sourceId === 'string' && plan.knowledge.snapshot.sourceId.trim()
      && typeof plan.knowledge.snapshot.versionId === 'string' && plan.knowledge.snapshot.versionId.trim()
      && validReference(plan.knowledge.memoryFunction));
    case 'static_ontology': return typeof plan.knowledge.releaseId === 'string' && Boolean(plan.knowledge.releaseId.trim());
    case 'append_only': return typeof plan.knowledge.anchorRelease === 'string' && Boolean(plan.knowledge.anchorRelease.trim())
      && Array.isArray(plan.knowledge.changes) && plan.knowledge.changes.every(change => change?.world && sameWorld(change.world, world)
        && typeof change.id === 'string' && change.id.trim() && typeof change.revision === 'string' && /^[1-9]\d*$/.test(change.revision)
        && Array.isArray(change.operations));
    default: return false;
  }
}

function FreezeSuiteForm({ suite, context, selectedTest, receipts }: { suite?: FrozenSuite; context: SuiteCreationContext; selectedTest: TestCase | null; receipts: Array<{ id: string }> }) {
  const { t } = useTranslation('world');
  const state = useWorldStore();
  const task = context.task;
  const world = context.branch.world;
  const taskId = task.id;
  const taskRevision = task.revision;
  const [suiteId, setSuiteId] = useState(suite?.id ?? '');
  const [plans, setPlans] = useState<PlanSelection[]>(suite?.plans ?? []);
  const planFiles = useRef<Partial<Record<PlanSelection['arm']['kind'], File>>>({});
  const [tests, setTests] = useState<TestRevision[]>(suite?.tests ?? []);
  const [protectedTests, setProtectedTests] = useState<TestRevision[]>(suite?.protectedCounterexamples ?? []);
  const [trainingBefore, setTrainingBefore] = useState(suite?.trainingBefore ?? '');
  const [holdoutFrom, setHoldoutFrom] = useState(suite?.holdoutFrom ?? '');
  const [readKind, setReadKind] = useState<ReadMode['kind'] | ''>('');
  const [maxLag, setMaxLag] = useState('');
  const [after, setAfter] = useState('');
  const [validAt, setValidAt] = useState('');
  const [knownAt, setKnownAt] = useState('');
  const [acceptance, setAcceptance] = useState<AcceptanceCriterion[]>(suite?.acceptance ?? []);
  const [budget, setBudget] = useState(suite?.conditions.totalBudget ?? task.budget);
  const [error, setError] = useState('');
  const arms = suite?.arms ?? evaluationArms;
  const basis = { policyEpoch: context.policyEpoch, grantEpoch: context.grantEpoch, toolLock: context.toolLock, dataDigest: context.dataDigest, modelBinding: suite ? suite.conditions.modelBinding : null };
  const required = (test: TestRevision) => suite?.tests.some(item => item.id === test.id && item.revision === test.revision);
  const canAdd = selectedTest && selectedTest.taskId === taskId && selectedTest.taskRevision === taskRevision && sameWorld(selectedTest.world, world) && !tests.some(item => item.id === selectedTest.id);
  const updateCriterion = (index: number, criterion: AcceptanceCriterion) => setAcceptance(items => items.map((item, position) => position === index ? criterion : item));
  return <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">{t(suite ? 'changes.freeze.nextTitle' : 'changes.freeze.firstTitle')}</summary><form className="mt-4 grid max-w-3xl gap-4" onSubmit={event => {
    event.preventDefault(); if (useWorldStore.getState().busy || !readKind || !validAt || !knownAt || !tests.length || !acceptance.length) return;
    try {
      let readMode: ReadMode;
      if (readKind === 'projected') {
        if (!/^(0|[1-9]\d*)$/.test(maxLag)) throw new Error(t('changes.freeze.lagError'));
        readMode = { kind: readKind, maxLag };
      } else if (readKind === 'after') {
        if (!receipts.some(receipt => receipt.id === after)) throw new Error(t('changes.freeze.receiptError'));
        readMode = { kind: readKind, receiptId: after };
      } else readMode = { kind: readKind };
      if (!suiteId || (!suite && !task.requiredSuites.includes(suiteId)) || arms.some(arm => !plans.some(plan => plan.arm.kind === arm.kind))) throw new Error(t('changes.freeze.plansError'));
      const input: FreezeSuite = { world, branch: context.branch, id: suiteId, revision: suite ? String(BigInt(suite.revision) + 1n) : '1', taskId, taskRevision, tests, protectedCounterexamples: protectedTests, trainingBefore: new Date(trainingBefore).toISOString(), holdoutFrom: new Date(holdoutFrom).toISOString(), arms, plans, acceptance, conditions: { ...basis, totalBudget: budget, readMode, validAt: new Date(validAt).toISOString(), knownAt: new Date(knownAt).toISOString() } };
      setError(''); void state.command({ kind: 'freeze_suite', request: input }).catch(error => setError(error instanceof Error ? error.message : t('changes.freeze.unknown')));
    } catch (error) { setError(error instanceof Error ? error.message : t('changes.freeze.invalid')); }
  }}><p className="text-xs text-muted-foreground">{suite ? t('changes.freeze.revisionHint', { revision: String(BigInt(suite.revision) + 1n) }) : t('changes.freeze.contextHint')} {t('changes.freeze.hint')}</p>
    <details><summary className="cursor-pointer text-sm">{t('changes.freeze.basis')}</summary><div className="mt-3"><FixedRecord value={suite ? { branch: context.branch, taskId, taskRevision, ...basis, plans } : context} /></div></details>
    {!suite && <><Field label={t('changes.freeze.requiredSuite')}><select required className={selectClass} value={suiteId} onChange={event => setSuiteId(event.target.value)}><option value="">{t('changes.freeze.chooseSuite')}</option>{task.requiredSuites.map(id => <option key={id} value={id}>{id}</option>)}</select></Field><p className="text-xs text-muted-foreground">{t('changes.freeze.plansHint')}</p>{arms.map(arm => {
      const plan = plans.find(item => item.arm.kind === arm.kind)?.plan;
      return <div key={arm.kind} className="space-y-2"><Field label={t('changes.freeze.armLabel', { arm: t(`changes.arms.${arm.kind}`) })}>{arm.kind === 'candidate' ? <select required className={selectClass} value={plan?.kind === 'strategy' ? `${plan.reference.id}:${plan.reference.revision}` : ''} onChange={event => {
        const reference = context.strategies.find(item => `${item.id}:${item.revision}` === event.target.value);
        setPlans(items => [...items.filter(item => item.arm.kind !== arm.kind), ...(reference ? [{ arm, plan: { kind: 'strategy' as const, reference } }] : [])]);
      }}><option value="">{t('changes.freeze.chooseStrategy')}</option>{context.strategies.map(item => <option key={`${item.id}:${item.revision}`} value={`${item.id}:${item.revision}`}>{item.id} · {item.revision}</option>)}</select> : <input className={selectClass} type="file" accept="application/json,.json" required={plan?.kind !== 'frozen'} disabled={state.busy} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
        planFiles.current[arm.kind] = file;
        setError(''); setPlans(items => items.filter(item => item.arm.kind !== arm.kind));
        if (file.size > 1_048_576) { setError(t('changes.freeze.frozenPlanError')); return; }
        void file.text().then(text => {
          if (planFiles.current[arm.kind] !== file) return;
          const reference: unknown = JSON.parse(text);
          if (!validFrozenPlan(reference, world, arm)) throw new Error(t('changes.freeze.frozenPlanError'));
          setPlans(items => [...items.filter(item => item.arm.kind !== arm.kind), { arm, plan: { kind: 'frozen', reference } }]);
        }).catch(() => { if (planFiles.current[arm.kind] === file) setError(t('changes.freeze.frozenPlanError')); });
      }} />}</Field>{plan?.kind === 'frozen' && <div className="space-y-1 break-words text-xs text-muted-foreground" role="status"><p>{t('changes.freeze.frozenPlanSummary', { id: plan.reference.strategy.id, revision: plan.reference.strategy.revision, definitions: plan.reference.definitions.length, tools: plan.reference.tools.length, scopes: plan.reference.scopes.length })}</p><p>{plan.reference.knowledge.kind === 'tool_memory' ? t('changes.freeze.memorySummary', { source: plan.reference.knowledge.snapshot.sourceId, version: plan.reference.knowledge.snapshot.versionId, function: plan.reference.knowledge.memoryFunction.id, revision: plan.reference.knowledge.memoryFunction.revision }) : plan.reference.knowledge.kind === 'static_ontology' ? t('changes.freeze.ontologySummary', { release: plan.reference.knowledge.releaseId }) : t('changes.freeze.appendSummary', { release: plan.reference.knowledge.anchorRelease, changes: plan.reference.knowledge.changes.length })}</p></div>}</div>;
    })}</>}
    <DataTable columns={[t('changes.test'), t('changes.revision'), t('changes.freeze.retention')]} rows={tests.map(test => [test.id, test.revision, required(test) ? t('changes.freeze.retained') : <button type="button" className="underline" onClick={() => { setTests(items => items.filter(item => item.id !== test.id)); setProtectedTests(items => items.filter(item => item.id !== test.id)); }}>{t('changes.freeze.removeTest')}</button>])} empty={t('changes.freeze.noTests')} /><div><Button type="button" size="sm" variant="outline" disabled={!canAdd} onClick={() => {
      if (!canAdd || !selectedTest) return;
      const reference = { id: selectedTest.id, revision: selectedTest.revision };
      setTests(items => [...items, reference]);
      if (selectedTest.purpose === 'counterexample') setProtectedTests(items => [...items, reference]);
    }}>{t('changes.freeze.addTest')}</Button></div>
    <div className="grid gap-3 sm:grid-cols-2"><TextField label={t('changes.freeze.trainingBefore')} value={trainingBefore} onChange={setTrainingBefore} /><TextField label={t('changes.freeze.holdoutFrom')} value={holdoutFrom} onChange={setHoldoutFrom} /><Field label={t('changes.freeze.readMode')}><select required className={selectClass} value={readKind} onChange={event => setReadKind(event.target.value as typeof readKind)}><option value="">{t('changes.freeze.chooseReadMode')}</option><option value="authoritative">{t('changes.freeze.authoritative')}</option><option value="projected">{t('changes.freeze.projected')}</option><option value="after">{t('changes.freeze.after')}</option></select></Field>{readKind === 'projected' && <TextField label={t('changes.freeze.maxLag')} value={maxLag} onChange={setMaxLag} />}{readKind === 'after' && <Field label={t('changes.freeze.receipt')}><select required className={selectClass} value={after} onChange={event => setAfter(event.target.value)}><option value="">{t('changes.freeze.chooseReceipt')}</option>{receipts.map(receipt => <option key={receipt.id} value={receipt.id}>{receipt.id}</option>)}</select></Field>}<TextField label={t('changes.freeze.validAt')} type="datetime-local" value={validAt} onChange={setValidAt} /><TextField label={t('changes.freeze.knownAt')} type="datetime-local" value={knownAt} onChange={setKnownAt} /></div>
    <div className="space-y-3"><p className="text-sm font-medium">{t('changes.freeze.acceptance')}</p>{acceptance.map((criterion, index) => <div className="flex flex-wrap items-end gap-2" key={index}><Field label={t('changes.freeze.criterionType')}><select className={selectClass} value={criterion.kind} onChange={event => {
      const kind = event.target.value as AcceptanceCriterion['kind'];
      updateCriterion(index, kind === 'minimum' || kind === 'maximum' ? { kind, metric: 'success', value: '' } : kind === 'hard_check' ? { kind, name: '' } : { kind });
    }}><option value="hard_check">{t('changes.criteria.hard_check')}</option><option value="minimum">{t('changes.criteria.minimum')}</option><option value="maximum">{t('changes.criteria.maximum')}</option><option value="no_protected_regression">{t('changes.criteria.no_protected_regression')}</option><option value="no_dangerous_effect">{t('changes.criteria.no_dangerous_effect')}</option></select></Field>{criterion.kind === 'hard_check' && <TextField label={t('changes.freeze.checkName')} value={criterion.name} onChange={name => updateCriterion(index, { ...criterion, name })} />}{(criterion.kind === 'minimum' || criterion.kind === 'maximum') && <><Field label={t('changes.report.metric')}><select className={selectClass} value={criterion.metric} onChange={event => updateCriterion(index, { ...criterion, metric: event.target.value as EvaluationMetric })}>{evaluationMetrics.map(metric => <option key={metric} value={metric}>{t(`changes.metrics.${metric}`)}</option>)}</select></Field><TextField label={t('changes.freeze.threshold')} value={criterion.value} onChange={value => updateCriterion(index, { ...criterion, value })} /></>}<Button type="button" size="sm" variant="outline" onClick={() => setAcceptance(items => items.filter((_, position) => position !== index))}>{t('changes.freeze.removeCriterion')}</Button></div>)}<Button type="button" size="sm" variant="outline" onClick={() => setAcceptance(items => [...items, { kind: 'hard_check', name: '' }])}>{t('changes.freeze.addCriterion')}</Button></div>
    <BudgetFields budget={budget} setBudget={setBudget} /><div><Button size="sm" disabled={state.busy || !readKind || !validAt || !knownAt || !tests.length || !acceptance.length}>{t(suite ? 'changes.freeze.submitRevision' : 'changes.freeze.submitFirst')}</Button></div>{error && <p className="text-sm text-destructive" role="alert">{error}</p>}
  </form></details>;
}

function EvaluationManagement() {
  const { t } = useTranslation('world');
  const state = useWorldStore();
  const [managing, setManaging] = useState(false);
  const [scope, setScope] = useState('');
  const [taskKey, setTaskKey] = useState('');
  const [suiteKey, setSuiteKey] = useState('');
  const [branchKey, setBranchKey] = useState('');
  const [testKey, setTestKey] = useState('');
  const [tasks, setTasks] = useState<Extract<QueryResult, { kind: 'tasks' }>['result'] | null>(null);
  const [suites, setSuites] = useState<Extract<QueryResult, { kind: 'suites' }>['result'] | null>(null);
  const [branches, setBranches] = useState<Extract<QueryResult, { kind: 'branches' }>['result'] | null>(null);
  const [tests, setTests] = useState<Extract<QueryResult, { kind: 'test_cases' }>['result'] | null>(null);
  const [frozen, setFrozen] = useState<FrozenSuite | null>(null);
  const [creation, setCreation] = useState<{ key: string; context: SuiteCreationContext } | null>(null);
  const [test, setTest] = useState<TestCase | null>(null);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const [suiteCursor, setSuiteCursor] = useState<string | null>(null);
  const [branchCursor, setBranchCursor] = useState<string | null>(null);
  const [testCursor, setTestCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [budget, setBudget] = useState<Budget>({ maxWallTime: '120000', maxSteps: '100', maxSourceReads: '100', maxRows: '10000', maxBytes: '268435456', maxModelCalls: '10', maxInputTokens: '100000', maxOutputTokens: '20000' });
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const task = tasks?.items.find(item => `${item.reference.id}:${item.reference.revision}` === taskKey);
  const suite = suites?.items.find(item => `${item.reference.id}:${item.reference.revision}` === suiteKey);
  const branch = branches?.items.find(item => `${item.id}:${item.revision}` === branchKey);
  const reference = tests?.items.find(item => `${item.id}:${item.revision}` === testKey);
  const world = state.world;
  const ready = state.description?.status === 'ready';
  const creationKey = JSON.stringify([world, state.description?.incarnation, state.description?.revision, branch?.id, branch?.revision, managing, revision]);
  useEffect(() => {
    let current = true; setSuites(null); setBranches(null); setError('');
    if (world && ready) {
      void queryWorld(world, { kind: 'suites', request: { page: { limit: 100, cursor: suiteCursor } } }, 'suites')
        .then(page => { if (current) setSuites(page); }).catch(error => { if (current) setError(error instanceof Error ? error.message : t('changes.manage.suitesError')); });
      void queryWorld(world, { kind: 'branches', request: { page: { limit: 100, cursor: branchCursor } } }, 'branches')
        .then(page => { if (current) setBranches(page); }).catch(error => { if (current) setError(error instanceof Error ? error.message : t('changes.manage.branchesError')); });
    }
    return () => { current = false; };
  }, [world, ready, state.description?.revision, suiteCursor, branchCursor, revision, t]);
  useEffect(() => {
    let current = true; setTasks(null); setTaskKey(''); setTests(null); setTestCursor(null);
    if (world && ready && managing && scope.trim()) void queryWorld(world, { kind: 'tasks', request: { scope: scope.trim(), page: { limit: 100, cursor: taskCursor } } }, 'tasks')
      .then(page => { if (current) setTasks(page); }).catch(error => { if (current) setError(error instanceof Error ? error.message : t('changes.manage.tasksError')); });
    return () => { current = false; };
  }, [world, ready, state.description?.revision, managing, scope, taskCursor, revision, t]);
  useEffect(() => {
    let current = true; setTests(null); setTestKey('');
    if (world && task) void queryWorld(world, { kind: 'test_cases', request: { task: task.reference, page: { limit: 100, cursor: testCursor } } }, 'test_cases')
      .then(page => { if (current) setTests(page); }).catch(error => { if (current) setError(error instanceof Error ? error.message : t('changes.manage.testsError')); });
    return () => { current = false; };
  }, [world, task, testCursor, revision, t]);
  useEffect(() => {
    let current = true; setFrozen(null);
    if (world && suite) void queryWorld(world, { kind: 'frozen_suite', request: suite.reference }, 'frozen_suite').then(value => {
      if (!current) return;
      if (!sameWorld(value.world, world) || value.id !== suite.reference.id || value.revision !== suite.reference.revision) throw new Error(t('changes.manage.suiteMismatch'));
      setFrozen(value);
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : t('changes.manage.frozenError')); });
    return () => { current = false; };
  }, [world, suite, t]);
  useEffect(() => {
    let current = true; setTest(null);
    if (world && reference) void queryWorld(world, { kind: 'exact_test_case', request: reference }, 'exact_test_case').then(value => {
      if (!current) return;
      if (!sameWorld(value.world, world) || value.id !== reference.id || value.revision !== reference.revision) throw new Error(t('changes.manage.testMismatch'));
      setTest(value);
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : t('changes.manage.testError')); });
    return () => { current = false; };
  }, [world, reference, t]);
  useEffect(() => {
    let current = true; setCreation(null);
    if (world && ready && branch && managing) {
      const reference = { world, id: branch.id, revision: branch.revision };
      void queryWorld(world, { kind: 'suite_creation_context', request: reference }, 'suite_creation_context').then(value => {
        if (!current) return;
        if (!sameWorld(value.branch.world, world) || value.branch.id !== reference.id || value.branch.revision !== reference.revision || !sameWorld(value.task.world, world)) throw new Error(t('changes.manage.contextMismatch'));
        setCreation({ key: creationKey, context: value });
      }).catch(error => { if (current) setError(error instanceof Error ? error.message : t('changes.manage.contextError')); });
    }
    return () => { current = false; };
  }, [world, ready, managing, branch, creationKey, t]);
  const currentCreation = world && ready && branch && creation?.key === creationKey && sameWorld(creation.context.branch.world, world)
    && creation.context.branch.id === branch.id && creation.context.branch.revision === branch.revision && sameWorld(creation.context.task.world, world) ? creation.context : null;
  const matchingCreation = currentCreation && task && currentCreation.task.id === task.reference.id && currentCreation.task.revision === task.reference.revision && sameWorld(currentCreation.task.world, task.reference.world) ? currentCreation : null;
  const matchingSuite = currentCreation && suite && frozen && sameWorld(frozen.world, currentCreation.branch.world)
    && sameWorld(suite.reference.world, frozen.world) && frozen.id === suite.reference.id && frozen.revision === suite.reference.revision
    && frozen.taskId === currentCreation.task.id && frozen.taskRevision === currentCreation.task.revision ? frozen : null;
  const freezeKey = currentCreation ? JSON.stringify([currentCreation.branch, currentCreation.policyEpoch, currentCreation.grantEpoch, currentCreation.toolLock, currentCreation.dataDigest]) : '';
  const validBudget = Object.values(budget).every(value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) && BigInt(budget.maxWallTime) > 0n && BigInt(budget.maxSteps) > 0n;
  return <Section title={t('changes.manage.title')} description={t('changes.manage.description')} action={<Button size="sm" variant="ghost" disabled={!world || state.busy} onClick={() => setRevision(value => value + 1)}>{t('changes.manage.refresh')}</Button>}>
    <div className="space-y-5">
      <form className="grid max-w-3xl gap-4" onSubmit={event => {
        event.preventDefault(); if (useWorldStore.getState().busy || !world || !ready || !branch || !suite || !validBudget) return;
        void state.command({ kind: 'test_branch', request: { branch: { world, id: branch.id, revision: branch.revision }, suite: suite.reference, budget } }).then(() => { if (mounted.current) setRevision(value => value + 1); }).catch(() => undefined);
      }}><Field label={t('changes.manage.branch')}><select required className={selectClass} value={branchKey} onChange={event => setBranchKey(event.target.value)}><option value="">{t('changes.manage.chooseBranch')}</option>{branches?.items.map(item => <option key={`${item.id}:${item.revision}`} value={`${item.id}:${item.revision}`}>{item.id} · {item.revision} · {t(`changes.replayability.${item.basis.replayability}`)}</option>)}</select></Field><div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={!branchCursor} onClick={() => setBranchCursor(null)}>{t('changes.manage.firstBranches')}</Button><Button type="button" size="sm" variant="outline" disabled={!branches?.nextCursor} onClick={() => setBranchCursor(branches?.nextCursor ?? null)}>{t('changes.manage.nextBranches')}</Button></div>
        {branch && <details><summary className="cursor-pointer text-sm">{t('changes.manage.branchBasis')}</summary><div className="mt-3"><FixedRecord value={branch.basis} /></div></details>}<Field label={t('changes.manage.suite')}><select required className={selectClass} value={suiteKey} onChange={event => setSuiteKey(event.target.value)}><option value="">{t('changes.manage.chooseSuite')}</option>{suites?.items.map(item => <option key={`${item.reference.id}:${item.reference.revision}`} value={`${item.reference.id}:${item.reference.revision}`}>{t('changes.manage.suiteValue', { id: item.reference.id, revision: item.reference.revision, task: item.task.id })}</option>)}</select></Field><div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={!suiteCursor} onClick={() => setSuiteCursor(null)}>{t('changes.manage.firstSuites')}</Button><Button type="button" size="sm" variant="outline" disabled={!suites?.nextCursor} onClick={() => setSuiteCursor(suites?.nextCursor ?? null)}>{t('changes.manage.nextSuites')}</Button></div>
        {frozen && <details className="rounded-xl border border-border p-3"><summary className="cursor-pointer text-sm">{t('changes.manage.frozenDetails')}</summary><div className="mt-3"><FixedRecord value={frozen} /></div></details>}
        <details><summary className="cursor-pointer text-sm">{t('changes.manage.budget')}</summary><div className="mt-3"><BudgetFields budget={budget} setBudget={setBudget} /></div></details><div><Button size="sm" disabled={state.busy || !ready || !branch || !suite || !validBudget}>{t('changes.manage.run')}</Button></div><p className="text-xs text-muted-foreground">{t('changes.manage.runHint')}</p>
      </form>
      <Button size="sm" variant="outline" aria-expanded={managing} onClick={() => setManaging(value => !value)}>{t(managing ? 'changes.manage.closeAdvanced' : 'changes.manage.openAdvanced')}</Button>
      {managing && <div className="space-y-4 rounded-xl border border-border p-4">
        <div className="grid max-w-3xl gap-3 sm:grid-cols-2"><TextField label={t('changes.manage.scope')} value={scope} onChange={value => { setScope(value); setTaskCursor(null); }} required={false} /><Field label={t('changes.manage.task')}><select className={selectClass} value={taskKey} onChange={event => { setTaskKey(event.target.value); setTestCursor(null); }}><option value="">{t('changes.manage.chooseTask')}</option>{tasks?.items.map(item => <option key={`${item.reference.id}:${item.reference.revision}`} value={`${item.reference.id}:${item.reference.revision}`}>{item.goal} · {item.reference.revision}</option>)}</select></Field></div>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={!taskCursor} onClick={() => setTaskCursor(null)}>{t('changes.manage.firstTasks')}</Button><Button size="sm" variant="outline" disabled={!tasks?.nextCursor} onClick={() => setTaskCursor(tasks?.nextCursor ?? null)}>{t('changes.manage.nextTasks')}</Button></div>
        {task && <><DataTable columns={[t('changes.test'), t('changes.revision')]} rows={tests?.items.map(item => [<button type="button" className="font-medium hover:underline" onClick={() => setTestKey(`${item.id}:${item.revision}`)}>{item.id}</button>, item.revision]) ?? []} empty={t('changes.manage.noTests')} /><div className="flex gap-2"><Button size="sm" variant="outline" disabled={!testCursor} onClick={() => setTestCursor(null)}>{t('changes.manage.firstTests')}</Button><Button size="sm" variant="outline" disabled={!tests?.nextCursor} onClick={() => setTestCursor(tests?.nextCursor ?? null)}>{t('changes.manage.nextTests')}</Button></div></>}
        {test && <details className="rounded-xl border border-border p-3"><summary className="cursor-pointer text-sm">{t('changes.manage.testDetails', { id: test.id, revision: test.revision })}</summary><div className="mt-3"><FixedRecord value={test} /></div></details>}
        {task && <RecordTestForm key={JSON.stringify([world, branchKey, taskKey, test?.id, test?.revision, freezeKey])} task={task} template={test} context={matchingCreation} />}
        {currentCreation && (!suiteKey ? <FreezeSuiteForm key={`create:${freezeKey}`} context={currentCreation} selectedTest={test} receipts={branch?.basis.readReceipts ?? []} /> : matchingSuite ? <FreezeSuiteForm key={`${matchingSuite.id}:${matchingSuite.revision}:${freezeKey}`} suite={matchingSuite} context={currentCreation} selectedTest={test} receipts={branch?.basis.readReceipts ?? []} /> : <p className="text-sm text-muted-foreground">{t('changes.manage.suiteContextHint')}</p>)}
        {!currentCreation && <p className="text-sm text-muted-foreground">{t('changes.manage.contextHint')}</p>}
      </div>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  </Section>;
}

function ReleaseHistory() {
  const { t, i18n } = useTranslation('world');
  const confirm = useWorldConfirmation();
  const state = useWorldStore();
  const world = state.world;
  const head = state.description?.activeReleaseHead;
  const [releases, setReleases] = useState<ReleaseView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollbackId, setRollbackId] = useState('');
  const release = releases.find(item => item.id === rollbackId);
  const version = useRef(0);
  useLayoutEffect(() => () => { version.current++; }, [rollbackOpen, rollbackId, release]);
  useEffect(() => {
    let current = true;
    if (world) void queryWorld(world, { kind: 'releases', request: { page: { limit: 100, cursor: null } } }, 'releases')
      .then(page => { if (current) setReleases(page.items); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : t('changes.releases.error')); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [world, t]);
  const rollback = async () => {
    const description = state.description;
    if (!world || !description || !head || !release || !sameWorld(head.world, world) || release.id === head.releaseId || !rollbackOpen) return;
    const read = version.current;
    const basis = JSON.stringify([world, description.incarnation, description.revision, head]);
    const command: WorldCommand = { kind: 'rollback', request: { releaseId: release.id, head: { world: head.world, channel: head.channel, expected: head, next: release.id } } };
    const current = () => {
      const latest = useWorldStore.getState();
      return read === version.current
        && latest.world && sameWorld(latest.world, world) && latest.description && sameWorld(latest.description.world, world)
        && latest.description.status === 'ready' && JSON.stringify([latest.world, latest.description.incarnation, latest.description.revision, latest.description.activeReleaseHead]) === basis
        && !latest.loading && !latest.busy && !latest.operationBusy && !latest.pending && !latest.pendingOperation && !latest.transferBusy;
    };
    if (!current() || !await confirm(t('changes.releases.confirmRollback')) || !current()) return;
    void useWorldStore.getState().command(command).catch(() => undefined);
  };
  return <Section title={t('changes.tabs.releases')} description={t('changes.releases.description')}>
    {loading ? <p className="text-sm text-muted-foreground" role="status">{t('changes.loading')}</p> : error ? <p className="text-sm text-destructive" role="alert">{error}</p> : releases.length ? <div className="space-y-4">
      {head && <details><summary className="cursor-pointer text-sm">{t('changes.releases.current')}</summary><div className="mt-3"><FixedRecord value={head} /></div></details>}
      <DataTable columns={[t('changes.releases.publishedAt'), t('changes.statusLabel'), t('changes.details')]} rows={releases.map(item => [new Date(item.publishedAt).toLocaleString(i18n.language), t(item.id === head?.releaseId ? 'changes.releases.current' : 'changes.releases.historical'), <details><summary className="cursor-pointer">{t('changes.releases.versionDetails')}</summary><div className="mt-3"><FixedRecord value={item} /></div></details>])} />
      <Button size="sm" variant="outline" disabled={!head || state.busy} aria-expanded={rollbackOpen} onClick={() => setRollbackOpen(value => !value)}>{t(rollbackOpen ? 'changes.releases.closeRollback' : 'changes.releases.openRollback')}</Button>
      {rollbackOpen && <div className="space-y-3 rounded-xl border border-border p-4"><p className="text-sm text-muted-foreground">{t('changes.releases.rollbackRisk')}</p><div className="flex flex-wrap items-end gap-3"><Field label={t('changes.releases.target')}><select className={selectClass} value={rollbackId} onChange={event => setRollbackId(event.target.value)}><option value="">{t('changes.releases.chooseTarget')}</option>{releases.filter(item => item.id !== head?.releaseId).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></Field><Button size="sm" variant="outline" disabled={state.busy || !head || !rollbackId} onClick={() => { void rollback(); }}>{t('changes.releases.rollback')}</Button></div></div>}
      {!head && <p className="text-sm text-muted-foreground">{t('changes.releases.noHead')}</p>}
    </div> : <Empty><p>{t('changes.releases.empty')}</p><Button size="sm" variant="link" asChild><Link to="/world/model">{t('changes.goModel')}</Link></Button></Empty>}
  </Section>;
}

export function Changes() {
  const world = useWorldStore(state => state.world);
  return <ChangesContent key={JSON.stringify(world)} />;
}

function ChangesContent() {
  const { t } = useTranslation('world');
  const confirm = useWorldConfirmation();
  const state = useWorldStore();
  const [tab, setTab] = useState('pending');
  const [showPast, setShowPast] = useState(false);
  const [id, setId] = useState('');
  const pending = state.changes.filter(item => ['proposed', 'validated', 'testing', 'ready'].includes(item.status));
  const visible = showPast ? state.changes : pending;
  const change = state.changes.find(item => item.id === id);
  const [reportId, setReportId] = useState('');
  const report = state.evaluations.find(item => item.id === reportId);
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const [rebaseId, setRebaseId] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [compile, setCompile] = useState<{ context: CompileRequest; changeId: string; changeRevision: string; value: CompileSelection } | null>(null);
  const context = state.description?.editingContext;
  const currentCompile = context && change && state.world && sameWorld(context.world, state.world) && context.baseRelease === state.description?.activeRelease && compile?.context === context && compile.changeId === change.id && compile.changeRevision === change.revision ? compile.value : null;
  const head = state.description?.activeReleaseHead;
  const version = useRef(0);
  useLayoutEffect(() => () => { version.current++; }, [id, reportId, tab]);
  const validate = (change: ChangeSet) => state.command({ kind: 'validate_change', request: { id: change.id, expectedRevision: change.revision } }).catch(() => undefined);
  const publish = async () => {
    const world = state.world;
    const description = state.description;
    if (!world || !description || !head || !change || !report || !sameWorld(head.world, world)
      || report.execution.kind !== 'completed' || report.verdict !== 'accepted') return;
    const read = version.current;
    const basis = JSON.stringify([world, description.incarnation, description.revision, head]);
    const changeBasis = JSON.stringify(change);
    const reportBasis = JSON.stringify(report);
    const command: WorldCommand = { kind: 'publish', request: { changeSetId: change.id, expectedRevision: change.revision, evaluationId: report.id,
      artifactId: crypto.randomUUID(), head: { world, channel: head.channel, expected: head, next: crypto.randomUUID() } } };
    const current = () => {
      const latest = useWorldStore.getState();
      return read === version.current
        && latest.world && sameWorld(latest.world, world) && latest.description && sameWorld(latest.description.world, world)
        && latest.description.status === 'ready' && JSON.stringify([latest.world, latest.description.incarnation, latest.description.revision, latest.description.activeReleaseHead]) === basis
        && JSON.stringify(latest.changes.find(item => item.id === change.id)) === changeBasis
        && JSON.stringify(latest.evaluations.find(item => item.id === report.id)) === reportBasis
        && !latest.loading && !latest.busy && !latest.operationBusy && !latest.pending && !latest.pendingOperation && !latest.transferBusy;
    };
    if (!current() || !await confirm(t('changes.review.confirmPublish')) || !current()) return;
    void useWorldStore.getState().command(command).catch(() => undefined);
  };
  const openEvaluation = () => { setEvaluationOpen(true); setTab('evaluation'); };
  const selectChange = (value: string) => { setId(value); setReportId(''); setRebaseId(''); setCompile(null); setReportOpen(false); };
  const staleBase = change && change.baseRelease !== state.description?.activeRelease;
  const needsValidation = change?.status === 'proposed';
  const reportAccepted = report?.execution.kind === 'completed' && report.verdict === 'accepted';
  const canPublish = change?.status === 'ready' && !staleBase && Boolean(head) && reportAccepted;
  return <Tabs value={tab} onValueChange={setTab} className="world-data-tabs">
    <TabsList variant="line" className="shrink-0" aria-label={t('changes.tabs.label')}><TabsTrigger value="pending">{t('changes.tabs.pending')}</TabsTrigger><TabsTrigger value="evaluation">{t('changes.tabs.evaluation')}</TabsTrigger><TabsTrigger value="releases">{t('changes.tabs.releases')}</TabsTrigger></TabsList>
    <TabsContent value="pending" className="world-data-content mt-0">
      <div className="world-atelier-content">
        <div className="world-review-layout world-panel">
          <aside className="world-catalog min-w-0">
            <header className="world-panel-header"><h2>{t('atelier.review.queue')}</h2><span className="text-xs tabular-nums text-muted-foreground">{visible.length}</span></header>
            <div className="space-y-3 p-3">
              <div className="flex flex-wrap gap-1" role="group" aria-label={t('atelier.review.queue')}>
                <Button size="sm" variant={showPast ? 'ghost' : 'outline'} aria-pressed={!showPast} onClick={() => setShowPast(false)}>{t('changes.review.showPending')}<span className="ml-1.5 tabular-nums text-muted-foreground">{pending.length}</span></Button>
                <Button size="sm" variant={showPast ? 'outline' : 'ghost'} aria-pressed={showPast} onClick={() => setShowPast(true)}>{t('changes.review.allTitle')}<span className="ml-1.5 tabular-nums text-muted-foreground">{state.changes.length}</span></Button>
              </div>
              {state.loading && !visible.length ? <p className="p-3 text-sm text-muted-foreground" role="status">{t('changes.loading')}</p> : visible.length ? <ul className="space-y-1">{visible.map(item => <li key={item.id}>
                <button type="button" className={`world-type-button !block space-y-2 border text-left ${item.id === change?.id ? 'border-ring/30' : 'border-transparent'}`} aria-pressed={item.id === change?.id} onClick={() => selectChange(item.id)}>
                  <span className="flex flex-wrap items-center justify-between gap-2"><span className="world-status" data-status={item.status}>{t(`changes.status.${item.status}`)}</span><span className="text-xs text-muted-foreground">{t('changes.diff.revisionValue', { revision: item.revision })}</span></span>
                  <span className="line-clamp-2 break-words text-sm font-medium leading-relaxed text-foreground">{item.rationale || t('changes.review.untitled')}</span>
                  <span className="block text-xs text-muted-foreground">{t('changes.review.operationCount', { count: item.operations.length })}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground" title={item.id}>{item.id}</span>
                </button>
              </li>)}</ul> : <Empty>{t('changes.review.empty')}</Empty>}
            </div>
          </aside>
          {change ? <>
            <article className="min-w-0 bg-[hsl(var(--shell-surface))]">
              <header className="space-y-3 border-b border-border p-5">
                <div className="flex flex-wrap items-center justify-between gap-3"><span className="break-all font-mono text-xs text-muted-foreground">{change.id} / {t('changes.diff.revisionValue', { revision: change.revision })}</span><span className="world-status" data-status={change.status}>{t(`changes.status.${change.status}`)}</span></div>
                <h2 className="break-words text-xl font-semibold leading-relaxed tracking-tight">{t('changes.review.change')}</h2>
              </header>
              <div className="world-panel-body space-y-6">
                <p className="whitespace-pre-wrap break-words text-sm leading-7">{change.rationale || t('changes.review.untitled')}</p>
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span>{t('changes.review.operationCount', { count: change.operations.length })}</span><span className="break-all">{t('atelier.review.baseRelease')} {change.baseRelease}</span></div>
                {staleBase && <section className="space-y-3 rounded-lg border border-border p-4">
                  <p className="text-sm text-muted-foreground">{t('changes.review.staleBase')}</p>
                  {rebaseId === change.id && <div className="space-y-3">
                    {context && <CompileSelectionFields key={JSON.stringify([change.id, change.revision, context])} context={context} definitionDrafts={change.operations.flatMap(operation => operation.kind === 'create_definition' ? [operation.definition] : operation.kind === 'refine_definition' || operation.kind === 'supersede_rule' ? [operation.replacement] : operation.kind === 'split_definition' ? operation.replacements : [])} onChange={value => setCompile(value ? { context, changeId: change.id, changeRevision: change.revision, value } : null)} />}
                    <Button size="sm" variant="outline" disabled={state.busy || !state.description?.activeRelease || !currentCompile || change.baseRelease === state.description.activeRelease} onClick={() => { if (state.description?.activeRelease && currentCompile) void state.command({ kind: 'rebase_change', request: { id: change.id, expectedRevision: change.revision, newBase: state.description.activeRelease, compile: currentCompile } }).catch(() => undefined); }}>{t('changes.review.submitRebase')}</Button>
                  </div>}
                </section>}
                <section><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{t('changes.review.diff')}</h3><GitCompareArrows className="h-4 w-4 text-muted-foreground" aria-hidden="true" /></div>{change.operations.length ? change.operations.map((operation, index) => <SemanticDifference key={JSON.stringify([change.id, change.revision, index])} operation={operation} />) : <p className="mt-3 text-sm text-muted-foreground">{t('changes.review.noOperations')}</p>}</section>
                <section className="space-y-3 border-t border-border pt-5">
                  <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">{t('changes.evidence')}</h3><span className="text-xs text-muted-foreground">{t('atelier.review.evidenceCount', { count: change.evidence.length })}</span></div>
                  {change.evidence.length ? <ul className="divide-y divide-border/60">{change.evidence.map(item => <li key={JSON.stringify(item)} className="flex min-w-0 items-start gap-3 py-3"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{item.id}</p><p className="mt-1 text-xs text-muted-foreground">{t('changes.diff.revisionValue', { revision: item.revision })}</p><details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">{t('changes.details')}</summary><div className="mt-3"><FixedRecord value={item} /></div></details></div></li>)}</ul> : <p className="text-sm text-muted-foreground">{t('changes.review.noEvidence')}</p>}
                  <p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.review.evidenceUnverified')}</p>
                </section>
                {report && <section className="space-y-3 border-t border-border pt-5">
                  <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h3 className="text-sm font-semibold">{t('changes.review.reportDetails')}</h3><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{report.id}</p></div><Button size="sm" variant="ghost" aria-expanded={reportOpen} onClick={() => setReportOpen(value => !value)}>{t(reportOpen ? 'changes.review.close' : 'changes.details')}</Button></div>
                  <p className="text-sm">{t(`changes.execution.${report.execution.kind}`)} · {t(`changes.verdict.${report.verdict}`)}</p><p className="text-xs text-muted-foreground">{t('changes.report.coverageValue', { tested: report.coverage.tested, total: report.coverage.total })}</p>
                  {reportOpen && <><p className="text-xs text-muted-foreground">{t(report.assurance === 'tested' ? 'changes.report.tested' : 'changes.report.untested')}</p><p className="break-all text-xs text-muted-foreground">{t('changes.report.candidate')}: {report.candidateId}</p><Button size="sm" variant="outline" onClick={() => { setEvaluationOpen(false); setTab('evaluation'); }}>{t('changes.diff.fullReport')}<ArrowUpRight className="ml-2 h-3.5 w-3.5" aria-hidden="true" /></Button></>}
                </section>}
                <details className="border-t border-border pt-4"><summary className="cursor-pointer text-xs text-muted-foreground">{t('changes.review.metadata')}</summary><div className="mt-3"><FixedRecord value={{ id: change.id, revision: change.revision, baseRelease: change.baseRelease, cases: change.cases, world: change.world }} /></div></details>
                <Button size="sm" variant="ghost" onClick={() => { setId(''); setReportOpen(false); }}>{t('changes.review.close')}</Button>
              </div>
            </article>
            <aside className="world-detail-panel min-w-0">
              <header className="world-panel-header"><h2>{t('changes.review.workflow')}</h2><Shield className="h-4 w-4 text-muted-foreground" aria-hidden="true" /></header>
              <div className="world-panel-body space-y-5">
                <ol className="world-trace text-sm">
                  <li aria-current={needsValidation || staleBase ? 'step' : undefined}>
                    <h3 className="font-semibold">{t('changes.review.structureValidation')}</h3><p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t('changes.review.structureHint')}</p>
                    <p className="mt-2 text-xs">{t(['validated', 'testing', 'ready', 'published'].includes(change.status) ? 'changes.status.validated' : `changes.status.${change.status}`)}</p>
                  </li>
                  <li aria-current={!staleBase && !canPublish && ['validated', 'testing', 'ready'].includes(change.status) ? 'step' : undefined}>
                    <h3 className="font-semibold">{t('changes.review.businessEvaluation')}</h3><p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t('changes.review.businessHint')}</p>
                    <p className="mt-2 text-xs">{report ? `${t(`changes.execution.${report.execution.kind}`)} · ${t(`changes.verdict.${report.verdict}`)}` : t('atelier.review.unverified')}</p>
                    {report?.execution.kind === 'failed' && <p className="mt-2 text-xs text-destructive" role="alert">{report.execution.failure.message}</p>}
                  </li>
                  <li aria-current={canPublish ? 'step' : undefined}><h3 className="font-semibold">{t('changes.review.confirmRelease')}</h3><p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t('changes.review.publishHint')}</p></li>
                </ol>
                <div className="space-y-3 border-t border-border pt-4">
                  <p className="text-xs font-medium text-muted-foreground">{t('changes.review.nextStep')}</p>
                  {staleBase && <Button size="sm" className="h-auto min-h-9 w-full whitespace-normal" aria-expanded={rebaseId === change.id} onClick={() => { setRebaseId(rebaseId === change.id ? '' : change.id); setCompile(null); }}>{t('changes.review.rebase')}</Button>}
                  {!canPublish && !staleBase && needsValidation && <Button size="sm" className="w-full" disabled={state.busy} onClick={() => { void validate(change); }}>{t('changes.review.validate')}</Button>}
                  <Button size="sm" variant={!staleBase && !needsValidation && !canPublish && ['validated', 'testing', 'ready'].includes(change.status) ? 'default' : 'outline'} className="w-full" onClick={openEvaluation}>{t('changes.review.evaluate')}</Button>
                  {(!needsValidation || staleBase) && <Button size="sm" variant="ghost" className="w-full" disabled={state.busy} onClick={() => { void validate(change); }}>{t('changes.review.validate')}</Button>}
                </div>
                <div className="space-y-3 border-t border-border pt-4">
                  <Field label={t('changes.review.report')}><select className={`${selectClass} w-full`} value={reportId} disabled={!state.evaluations.length} onChange={event => { setReportId(event.target.value); setReportOpen(Boolean(event.target.value)); }}><option value="">{t(state.evaluations.length ? 'changes.review.chooseReport' : 'changes.review.noReports')}</option>{state.evaluations.map(item => <option key={item.id} value={item.id}>{item.id} · {t(`changes.execution.${item.execution.kind}`)} · {t(`changes.verdict.${item.verdict}`)}</option>)}</select></Field>
                  <Button size="sm" variant={canPublish ? 'default' : 'outline'} className="w-full" disabled={state.busy || !canPublish} onClick={publish}>{t('changes.review.publish')}</Button>
                  <p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.review.reportBindingHint')}</p>
                  {!head && <p className="text-xs text-muted-foreground">{t('changes.releases.noHead')}</p>}
                </div>
                <details className="border-t border-border pt-4">
                  <summary className="cursor-pointer text-sm font-medium">{t('atelier.review.releaseChecks')}</summary>
                  <dl className="mt-3 divide-y divide-border/60 text-xs"><div className="space-y-1 pb-3"><dt className="text-muted-foreground">{t('atelier.review.baseRelease')}</dt><dd>{!state.description?.activeRelease ? t('atelier.review.unverified') : staleBase ? t('changes.review.staleBase') : t('atelier.review.matchesCurrent')}</dd></div><div className="space-y-1 py-3"><dt className="text-muted-foreground">{t('atelier.review.evidenceValidity')}</dt><dd>{t('atelier.review.unverified')}</dd></div><div className="space-y-1 pt-3"><dt className="text-muted-foreground">{t('atelier.review.authorization')}</dt><dd>{t('atelier.review.checkedOnPublish')}</dd></div></dl>
                </details>
                {report && <section className="space-y-3 border-t border-border pt-4"><h3 className="text-xs font-medium">{t('changes.report.hardCheck')}</h3>{report.hardChecks.length ? <ul className="space-y-2">{report.hardChecks.map((item, index) => <li key={index} className="flex items-start justify-between gap-3 text-xs"><span className="break-words">{item.name}</span><span className={`shrink-0 ${item.passed ? 'text-muted-foreground' : 'text-destructive'}`}>{t(item.passed ? 'changes.passed' : 'changes.notPassed')}</span></li>)}</ul> : <p className="text-xs leading-relaxed text-muted-foreground">{t('changes.report.noHardChecks')}</p>}</section>}
              </div>
            </aside>
          </> : <article className="col-[auto/-1] min-w-0 bg-[hsl(var(--shell-surface))]"><Empty icon={<GitCompareArrows className="h-7 w-7" />} title={t('atelier.review.selectChange')} description={t('atelier.review.selectChangeHint')} action={<><Button size="sm" variant="outline" asChild><Link to="/world?tab=materials">{t('changes.goMaterials')}</Link></Button><Button size="sm" variant="outline" asChild><Link to="/world/model">{t('changes.goModel')}</Link></Button></>} /></article>}
        </div>
      </div>
    </TabsContent>
    <TabsContent value="evaluation" className="world-data-content mt-0">
      {evaluationOpen ? <div className="world-content-page space-y-5"><Button size="sm" variant="ghost" onClick={() => setEvaluationOpen(false)}>{t('changes.reports.closeRun')}</Button><EvaluationManagement /></div> : <div className="world-review-workbench" data-selected={Boolean(report)}><div className="world-review-main"><header className="space-y-3 border-b border-border px-5 py-4"><p className="text-sm text-muted-foreground">{t('changes.reports.description')}</p><Button size="sm" variant="outline" onClick={() => setEvaluationOpen(true)}>{t('changes.reports.openRun')}</Button></header>
        {state.evaluations.length ? <ul className="divide-y divide-border/70">{state.evaluations.map(item => <li key={item.id}><button type="button" className={`w-full space-y-2 px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${item.id === reportId ? 'bg-accent/50' : 'hover:bg-secondary/30'}`} aria-pressed={item.id === reportId} onClick={() => setReportId(item.id)}><span className="block text-sm font-medium">{t(`changes.verdict.${item.verdict}`)}</span><span className="block text-xs text-muted-foreground">{t(`changes.execution.${item.execution.kind}`)} · {item.coverage.tested} / {item.coverage.total}</span><span className="block break-words text-xs text-muted-foreground">{item.id}</span></button></li>)}</ul> : <Empty>{t('changes.reports.empty')}</Empty>}
      </div>{report && <article className="world-document space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2>{t('changes.reports.title')}</h2><Button size="sm" variant="ghost" onClick={() => setReportId('')}>{t('changes.review.close')}</Button></div><EvaluationReportView report={report} />{change && <Button size="sm" variant="outline" onClick={() => { setReportOpen(true); setTab('pending'); }}>{t('changes.review.back')}</Button>}</article>}</div>}
    </TabsContent>
    <TabsContent value="releases" className="world-content-page mt-0"><ReleaseHistory key={JSON.stringify([state.world, head])} /></TabsContent>
  </Tabs>;
}
