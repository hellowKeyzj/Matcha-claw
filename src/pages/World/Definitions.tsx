import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Box, Braces, ChevronDown, GitBranch, Maximize2, Minus, Plus, Search, Share2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWorldStore } from '@/stores/world';
import { queryWorld, sameWorld } from '@/stores/world/client';
import type { CompileRequest, CompileSelection, Definition, ExpressionIr, SemanticOperation, TaskSummary, Value, ValueType } from '@/types/world';
import { DataTable, definitionName, Empty, Field, selectClass, TextField } from './components';
import { CompileSelectionFields } from './CompileSelection';
import { Tasks } from './Tasks';
import { ModelAuthoring } from './ModelAuthoring';
import { RuleEvaluation } from './RuleEvaluation';

const kinds: Definition['body']['kind'][] = ['object_type', 'property', 'relation_type', 'facet', 'concept_view', 'rule', 'metric', 'function', 'state_model', 'action_contract', 'strategy', 'policy_binding', 'source_binding'];

function literalText(t: TFunction<'world'>, value: Value, depth = 0): string {
  if (depth > 12) return t('model.record.depthLimit');
  switch (value.kind) {
  case 'null': return t('model.valueTypes.null');
  case 'boolean': return t(value.value ? 'actions.field.yes' : 'actions.field.no');
  case 'money': return `${value.amount} ${value.currency}`;
  case 'quantity': return `${value.amount} ${value.unit.code}`;
  case 'duration': return `${value.milliseconds} ms`;
  case 'object': case 'relation': return value.id;
  case 'list': return `[${value.items.map(item => literalText(t, item, depth + 1)).join(', ')}]`;
  case 'record': return `{${Object.entries(value.fields).map(([key, item]) => `${key}: ${literalText(t, item, depth + 1)}`).join(', ')}}`;
  default: return value.kind === 'text' ? JSON.stringify(value.value) : value.value;
  }
}

function expressionText(t: TFunction<'world'>, expression: ExpressionIr, depth = 0): string {
  if (depth > 12) return t('model.record.depthLimit');
  const child = (value: ExpressionIr) => expressionText(t, value, depth + 1);
  switch (expression.kind) {
  case 'literal': return literalText(t, expression.value);
  case 'parameter': return expression.id;
  case 'field': return `${expression.subject}.${expression.property.id}`;
  case 'role': return `${expression.relation}.${expression.role}`;
  case 'unary': return `${expression.operator === 'not' ? '¬' : '−'}(${child(expression.operand)})`;
  case 'binary': {
    const operators = { equal: '=', not_equal: '≠', less: '<', less_or_equal: '≤', greater: '>', greater_or_equal: '≥', add: '+', subtract: '−', multiply: '×', divide: '÷', contains: t('model.expression.contains') };
    return `(${child(expression.left)} ${operators[expression.operator]} ${child(expression.right)})`;
  }
  case 'all': return `${t('model.expression.aggregate.all')}(${expression.terms.map(child).join(', ')})`;
  case 'any': return `${t('model.expression.aggregate.any')}(${expression.terms.map(child).join(', ')})`;
  case 'if': return t('model.expression.ifThenElse', { condition: child(expression.condition), then: child(expression.thenValue), else: child(expression.elseValue) });
  case 'call': return `${expression.function.id}(${expression.arguments.map(child).join(', ')})`;
  case 'aggregate': {
    const window = expression.window;
    const interval = !window ? '' : window.kind === 'fixed' ? `${window.interval.from} — ${window.interval.to ?? t('model.details.ongoing')}` : `${window.timestampProperty.id} · ${window.width} ms`;
    return `${t(`model.expression.aggregate.${expression.operator}`)}(${expression.collection}: ${child(expression.expression)})${interval ? ` [${interval}]` : ''}`;
  }
  case 'is_null': return `${t('model.expression.isNull')}(${child(expression.operand)})`;
  case 'is_known': return `${t('model.expression.isKnown')}(${child(expression.operand)})`;
  }
}

function valueTypeText(t: TFunction<'world'>, type: ValueType): string {
  const label = t(`model.valueTypes.${type.kind}`);
  switch (type.kind) {
  case 'decimal': return `${label} (${type.precision}, ${type.scale})`;
  case 'money': return `${label} · ${type.currency}`;
  case 'quantity': return `${label} · ${type.unit.code}`;
  case 'object': case 'relation': return `${label} · ${type.typeId}`;
  case 'timestamp': return `${label} · ${type.timeZone}`;
  case 'date': return `${label} · ${type.calendar}`;
  case 'text': return `${label} · ${t('model.content.maxLength', { count: type.maxLength })}`;
  case 'list': return `${label} · ${t('model.content.maxItems', { count: type.maxItems })}`;
  default: return label;
  }
}

function DefinitionContent({ definition }: { definition: Definition }) {
  const { t } = useTranslation('world');
  const body = definition.body;
  const block = (label: string, content: ReactNode) => <section className="space-y-2 border-b border-border/60 pb-5"><h3 className="text-xs font-medium text-muted-foreground">{label}</h3><div className="break-words text-sm leading-relaxed">{content}</div></section>;
  const expression = (value: ExpressionIr) => <code className="whitespace-pre-wrap break-words font-mono text-sm leading-7">{expressionText(t, value)}</code>;
  let content: ReactNode;
  switch (body.kind) {
  case 'rule': {
    const conclusion = body.body.conclusion;
    content = <>{block(t('model.content.condition'), expression(body.body.condition))}{block(t('model.content.conclusion'), <div className="space-y-2"><p>{t(`model.content.polarity.${conclusion.polarity}`)}</p>{conclusion.kind === 'attribute' ? <p>{expression(conclusion.subject)} · {conclusion.property.id} = {expression(conclusion.value)}</p> : <><p>{conclusion.relationType.id} · {expression(conclusion.relation)}</p>{conclusion.roles.map((role, index) => <p key={index}>{role.role}: {expression(role.object)}</p>)}</>}</div>)}</>;
    break;
  }
  case 'metric': case 'function': content = <>{block(t('model.content.expression'), expression(body.body.expression))}{block(t('model.content.resultType'), valueTypeText(t, body.body.resultType))}</>; break;
  case 'property': content = <>{block(t('model.content.valueType'), valueTypeText(t, body.body.valueType))}{block(t('model.content.appliesTo'), body.body.domain.join(' · '))}{block(t('model.content.nullable'), t(body.body.nullable ? 'actions.field.yes' : 'actions.field.no'))}{block(t('atelier.model.cardinality'), `${body.body.cardinality.minimum}..${body.body.cardinality.maximum ?? '∞'}`)}</>; break;
  case 'object_type': content = <>{block(t('model.content.properties'), body.body.properties.length ? <ul className="space-y-2">{body.body.properties.map(item => <li key={referenceKey(item)} className="flex flex-wrap justify-between gap-x-3"><span className="break-all">{item.id}</span><span className="text-xs tabular-nums text-muted-foreground">{t('atelier.shell.revision', { revision: item.revision })}</span></li>)}</ul> : t('model.record.none'))}{block(t('model.content.sources'), body.body.sourceBindings.map(item => `${item.id} / ${item.revision}`).join(' · ') || t('model.record.none'))}</>; break;
  case 'relation_type': content = block(t('atelier.model.roles'), <dl className="space-y-3">{body.body.roles.map(role => <div key={role.id}><dt className="flex flex-wrap justify-between gap-x-3 font-medium"><span>{role.name}</span><span className="font-normal tabular-nums text-muted-foreground">{role.cardinality.minimum}..{role.cardinality.maximum ?? '∞'}</span></dt><dd className="mt-1 break-all text-xs text-muted-foreground">{role.id} → {role.targetType.id} / {role.targetType.revision}</dd></div>)}</dl>); break;
  case 'facet': content = <>{block(t('model.content.appliesTo'), body.body.attachesTo.join(' · '))}{block(t('model.content.condition'), expression(body.body.applicability))}</>; break;
  case 'concept_view': content = <>{block(t('model.content.inputs'), body.body.inputs.join(' · '))}{block(t('model.content.outputs'), <dl className="space-y-3">{body.body.query.output.map((column, index) => <div key={index}><dt className="font-medium">{column.name}</dt><dd>{expression(column.expression)}</dd></div>)}</dl>)}</>; break;
  case 'state_model': content = <>{block(t('model.content.states'), body.body.states.map(item => item.name).join(' · '))}{block(t('model.content.transitions'), <div className="space-y-3">{body.body.transitions.map((item, index) => <p key={index}>{item.from} → {item.to}<br />{expression(item.guard)}</p>)}</div>)}</>; break;
  case 'action_contract': content = <>{block(t('actions.riskLabel'), t(`actions.risk.${body.body.risk}`))}{block(t('actions.approvalLabel'), t(`actions.approval.${body.body.approval}`))}{block(t('model.content.preconditions'), <div className="space-y-2">{body.body.preconditions.map((item, index) => <p key={index}>{expression(item)}</p>)}</div>)}{block(t('model.content.expectedEffect'), expression(body.body.expectedEffect))}</>; break;
  case 'strategy': content = <>{block(t('model.content.condition'), expression(body.body.guard))}{block(t('model.content.steps'), <ol className="list-inside list-decimal space-y-3">{body.body.steps.map((step, index) => <li key={index}><span>{t(`model.content.operations.${step.operation.kind}`)}</span><div className="mt-1">{expression(step.guard)}</div></li>)}</ol>)}</>; break;
  case 'policy_binding': content = <>{block(t('model.details.scope'), body.body.scope)}{block(t('model.content.condition'), expression(body.body.predicate))}</>; break;
  case 'source_binding': content = <>{block(t('model.content.source'), body.body.sourceId)}{block(t('model.content.resource'), body.body.resource)}{block(t('model.details.scope'), body.body.scope)}</>; break;
  }
  return <div className="space-y-5">{content}{'parameters' in body.body && body.body.parameters.length > 0 && block(t('model.content.parameters'), <dl className="space-y-3">{body.body.parameters.map(parameter => <div key={parameter.id}><dt className="font-medium">{parameter.id}</dt><dd className="text-muted-foreground">{valueTypeText(t, parameter.valueType)}{parameter.optional ? ` · ${t('model.content.optional')}` : ''}{parameter.nullable ? ` · ${t('model.content.nullable')}` : ''}</dd></div>)}</dl>)}</div>;
}

export function DefinitionDetails({ definition }: { definition: Definition }) {
  const { t } = useTranslation('world');
  return <div className="space-y-5">
    <DefinitionContent definition={definition} />
    <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('atelier.model.identity')}</summary><dl className="mt-4 grid min-w-0 gap-3 text-sm">{[
      [t('model.type'), t(`model.kinds.${definition.body.kind}`)], [t('model.details.id'), definition.reference.id], [t('model.details.revision'), definition.reference.revision],
      [t('model.details.scope'), definition.scope], [t('model.details.lifecycle'), t(`atelier.model.lifecycle.${definition.lifecycle.kind}`)],
      [t('model.details.validTime'), `${definition.validTime.from} — ${definition.validTime.to ?? t('model.details.ongoing')}`], [t('model.details.digest'), definition.contentDigest],
    ].map(([label, value]) => <div className="grid min-w-0 gap-1 sm:grid-cols-[9rem_1fr]" key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="min-w-0 break-all">{value}</dd></div>)}</dl></details>
    <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('model.evidence')} <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">{definition.dependencies.length} / {definition.evidence.length}</span></summary><div className="mt-4 space-y-4"><DataTable columns={[t('model.details.dependency'), t('model.details.revision')]} rows={definition.dependencies.map(reference => [reference.id, reference.revision])} empty={t('model.details.noDependencies')} /><DataTable columns={[t('model.details.evidence'), t('model.details.revision')]} rows={definition.evidence.map(reference => [reference.id, reference.revision])} empty={t('model.details.noEvidence')} /></div></details>
    <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t('model.metadata')}</summary><div className="mt-4"><FixedRecord value={definition} /></div></details>
  </div>;
}

// Fixed data rendering only: values never become HTML, scripts or third-party components.
export function FixedRecord({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const { t } = useTranslation('world');
  if (value == null) return <span className="text-muted-foreground">{t('model.record.unset')}</span>;
  if (typeof value !== 'object') return <span className="break-words">{String(value)}</span>;
  if (depth >= 12) return <span className="text-muted-foreground">{t('model.record.depthLimit')}</span>;
  if (Array.isArray(value)) return value.length ? <ol className="space-y-2">{value.map((item, index) => <li className="border-l border-border pl-3" key={index}><FixedRecord value={item} depth={depth + 1} /></li>)}</ol> : <span className="text-muted-foreground">{t('model.record.none')}</span>;
  return <dl className="grid gap-2">{Object.entries(value).map(([key, item]) => <div className="grid gap-1 sm:grid-cols-[10rem_1fr]" key={key}><dt className="break-words text-xs text-muted-foreground">{key}</dt><dd className="min-w-0 text-sm"><FixedRecord value={item} depth={depth + 1} /></dd></div>)}</dl>;
}

function referenceKey(reference: Definition['reference']) {
  return JSON.stringify([reference.world.tenantId, reference.world.worldId, reference.id, reference.revision]);
}

function SchemaCanvas({ definitions, selected, onSelect }: { definitions: Definition[]; selected: string; onSelect(key: string): void }) {
  const { t } = useTranslation('world');
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => {
    const byReference = new Map(definitions.map(item => [referenceKey(item.reference), item]));
    const owners = definitions.filter(item => item.body.kind === 'object_type' || item.body.kind === 'relation_type');
    const attached = new Set(owners.flatMap(item => item.body.kind === 'object_type' || item.body.kind === 'relation_type' ? item.body.body.properties.map(referenceKey) : []));
    const entities = definitions.filter(item => item.body.kind === 'object_type' || (item.body.kind === 'property' && !attached.has(referenceKey(item.reference))));
    const relations = definitions.filter(item => item.body.kind === 'relation_type');
    const missing = new Map<string, Definition['reference']>();
    for (const item of relations) if (item.body.kind === 'relation_type') for (const role of item.body.body.roles) {
      if (!byReference.has(referenceKey(role.targetType))) missing.set(referenceKey(role.targetType), role.targetType);
    }
    const lanes = [32, 80];
    const nodes: Array<{ key: string; reference: Definition['reference']; definition?: Definition; properties: Definition['reference'][]; x: number; y: number; width: number; height: number }> = [];
    for (const [index, item] of [...entities, ...missing.values()].entries()) {
      const definition = 'body' in item ? item : undefined;
      const reference = 'body' in item ? item.reference : item;
      const properties = definition?.body.kind === 'object_type' ? definition.body.body.properties : [];
      const lane = index % 2;
      const height = definition?.body.kind === 'property' ? 112 : 68 + Math.max(1, properties.length) * 44;
      nodes.push({ key: referenceKey(reference), reference, definition, properties, x: lane ? 640 : 24, y: lanes[lane], width: 248, height });
      lanes[lane] += height + 48;
    }
    let relationY = 56;
    for (const item of relations) {
      if (item.body.kind !== 'relation_type') continue;
      const height = 68 + Math.max(1, item.body.body.roles.length) * 44 + item.body.body.properties.length * 44;
      nodes.push({ key: referenceKey(item.reference), reference: item.reference, definition: item, properties: item.body.body.properties, x: 352, y: relationY, width: 208, height });
      relationY += height + 56;
    }
    const byNode = new Map(nodes.map(node => [node.key, node]));
    const edges = nodes.flatMap(node => node.definition?.body.kind === 'relation_type' ? node.definition.body.body.roles.flatMap((role, index) => {
      const target = byNode.get(referenceKey(role.targetType));
      if (!target) return [];
      const right = target.x > node.x;
      const x1 = right ? node.x + node.width : node.x;
      const x2 = right ? target.x : target.x + target.width;
      const y1 = node.y + 90 + index * 44;
      const y2 = target.y + 34;
      const bend = (x1 + x2) / 2;
      return [{ key: `${node.key}:${role.id}`, source: node.key, target: target.key, role, path: `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}`, x: bend, y: (y1 + y2) / 2 }];
    }) : []);
    return { nodes, edges, byReference, width: 912, height: Math.max(520, ...nodes.map(node => node.y + node.height + 40)) };
  }, [definitions]);
  useEffect(() => {
    const node = layout.nodes.find(item => item.key === selected || item.properties.some(reference => referenceKey(reference) === selected));
    if (!node || !viewport.current) return;
    viewport.current.scrollTo({ left: Math.max(0, (node.x + node.width / 2) * zoom - viewport.current.clientWidth / 2), top: Math.max(0, (node.y + node.height / 2) * zoom - viewport.current.clientHeight / 2) });
  }, [selected, layout, zoom]);
  const cardinality = (value: { minimum: number; maximum?: number | null }) => `${value.minimum}..${value.maximum ?? '∞'}`;
  return <div className="min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><Box className="h-3.5 w-3.5" aria-hidden="true" />{t('model.kinds.object_type')}</span><span className="inline-flex items-center gap-1.5"><Braces className="h-3.5 w-3.5" aria-hidden="true" />{t('model.kinds.property')}</span><span className="inline-flex items-center gap-1.5"><Share2 className="h-3.5 w-3.5" aria-hidden="true" />{t('model.kinds.relation_type')}</span></div>
      <div className="flex min-w-0 flex-wrap items-center gap-1"><Button size="icon" variant="ghost" className="h-8 w-8" disabled={zoom <= 0.8} aria-label={t('atelier.model.zoomOut')} onClick={() => setZoom(value => Math.max(0.8, +(value - 0.1).toFixed(1)))}><Minus className="h-4 w-4" aria-hidden="true" /></Button><output className="min-w-12 text-center text-xs tabular-nums" aria-live="polite">{Math.round(zoom * 100)}%</output><Button size="icon" variant="ghost" className="h-8 w-8" disabled={zoom >= 1.5} aria-label={t('atelier.model.zoomIn')} onClick={() => setZoom(value => Math.min(1.5, +(value + 0.1).toFixed(1)))}><Plus className="h-4 w-4" aria-hidden="true" /></Button><Button size="icon" variant="ghost" className="h-8 w-8" aria-label={t('atelier.model.fit')} onClick={() => { setZoom(1); viewport.current?.scrollTo({ left: 0, top: 0 }); }}><Maximize2 className="h-4 w-4" aria-hidden="true" /></Button></div>
    </div>
    <div ref={viewport} className="world-canvas h-[clamp(20rem,45vh,38rem)]" role="region" tabIndex={0} aria-label={t('atelier.model.canvasLabel')}>
      {!layout.nodes.length ? <div className="flex h-full items-center justify-center p-8"><Empty icon={<Share2 className="h-5 w-5" />} description={t('atelier.model.noGraph')} /></div> : <div className="relative" style={{ width: layout.width * zoom, height: layout.height * zoom }}><div className="absolute left-0 top-0 origin-top-left" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
        <svg className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map(edge => { const active = selected === edge.source || selected === edge.target; return <g key={edge.key}><path d={edge.path} fill="none" stroke={active ? 'hsl(var(--ring))' : 'hsl(var(--muted-foreground))'} strokeWidth={active ? 2 : 1.25} opacity={active ? 1 : 0.5} /><rect x={edge.x - 24} y={edge.y - 11} width={48} height={22} rx={6} fill="hsl(var(--shell-surface))" stroke="hsl(var(--shell-border))" /><text x={edge.x} y={edge.y + 4} textAnchor="middle" fill="hsl(var(--foreground))" fontSize={12}>{cardinality(edge.role.cardinality)}</text></g>; })}
        </svg>
        {layout.nodes.map(node => {
          const item = node.definition;
          if (!item) return <div key={node.key} className="absolute rounded-lg border border-dashed border-border bg-background p-3 text-sm" style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}><p className="break-words font-medium">{node.reference.id}</p><p className="mt-1 text-xs text-muted-foreground">{t('model.details.revision')} · {node.reference.revision}</p><p className="mt-2 text-xs text-muted-foreground">{t('atelier.model.missingDefinition')}</p></div>;
          const active = selected === node.key;
          const Icon = item.body.kind === 'object_type' ? Box : item.body.kind === 'relation_type' ? Share2 : Braces;
          return <section key={node.key} className={`absolute overflow-hidden rounded-lg border bg-background shadow-sm ${active ? 'border-ring ring-1 ring-ring/30' : 'border-border'}`} style={{ left: node.x, top: node.y, width: node.width }}>
            <button type="button" className={`flex h-[68px] w-full items-center gap-2.5 px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${active ? 'bg-secondary' : 'hover:bg-secondary/50'}`} aria-pressed={active} onClick={() => onSelect(node.key)} title={`${definitionName(item)} · ${node.reference.id} / ${node.reference.revision}`}><span className="rounded-md border border-border bg-background p-1.5"><Icon className="h-4 w-4" aria-hidden="true" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{definitionName(item)}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{t(`model.kinds.${item.body.kind}`)} · {node.reference.revision}</span></span></button>
            {item.body.kind === 'relation_type' && (item.body.body.roles.length ? item.body.body.roles.map(role => <button key={role.id} type="button" className="flex h-11 w-full items-center gap-2 border-t border-border/70 px-3 text-left hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => onSelect(node.key)} title={`${role.name} (${role.id}) · ${role.targetType.id} / ${role.targetType.revision} · ${cardinality(role.cardinality)}`}><Share2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-sm">{role.name}</span><span className="text-xs text-muted-foreground">{cardinality(role.cardinality)}</span></button>) : <p className="flex h-11 items-center border-t border-border px-3 text-xs text-muted-foreground">{t('model.record.none')}</p>)}
            {node.properties.map(reference => {
              const property = layout.byReference.get(referenceKey(reference));
              return <button type="button" key={referenceKey(reference)} disabled={!property} aria-pressed={selected === referenceKey(reference)} className={`flex h-11 w-full items-center gap-2 border-t border-border/70 px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default ${selected === referenceKey(reference) ? 'bg-secondary' : 'hover:bg-secondary/50'}`} onClick={() => onSelect(referenceKey(reference))} title={property ? `${definitionName(property)} · ${reference.id} / ${reference.revision}` : `${reference.id} / ${reference.revision} · ${t('atelier.model.missingDefinition')}`}><Braces className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{property ? definitionName(property) : reference.id}</span><span className="block truncate text-xs text-muted-foreground">{property?.body.kind === 'property' ? valueTypeText(t, property.body.body.valueType) : t('atelier.model.missingDefinition')}</span></span>{property?.body.kind === 'property' && <span className="text-xs text-muted-foreground">{cardinality(property.body.body.cardinality)}</span>}</button>;
            })}
            {item.body.kind === 'object_type' && !node.properties.length && <p className="flex h-11 items-center border-t border-border px-3 text-xs text-muted-foreground">{t('model.record.none')}</p>}
            {item.body.kind === 'property' && <p className="flex h-11 items-center justify-between gap-2 border-t border-border px-3 text-xs text-muted-foreground"><span className="truncate" title={valueTypeText(t, item.body.body.valueType)}>{valueTypeText(t, item.body.body.valueType)}</span><span>{cardinality(item.body.body.cardinality)}</span></p>}
          </section>;
        })}
      </div></div>}
    </div>
    <div className="space-y-3 border-t border-border px-4 py-3">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.model.loadedOnly')}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.overview.graphHint')}</p>
      <details><summary className="cursor-pointer text-xs font-medium">{t('atelier.model.relationList')}</summary><div className="mt-3"><DataTable columns={[t('model.kinds.relation_type'), t('model.content.roles'), t('model.content.appliesTo'), t('atelier.model.cardinality')]} rows={layout.edges.map(edge => {
        const source = layout.byReference.get(edge.source)!;
        const target = layout.byReference.get(edge.target);
        return [<button type="button" className="text-left underline underline-offset-4" onClick={() => onSelect(edge.source)}>{definitionName(source)} · {source.reference.revision}</button>, <span>{edge.role.name}<span className="mt-1 block break-all text-xs text-muted-foreground">{edge.role.id}</span></span>, target ? <button type="button" className="text-left underline underline-offset-4" onClick={() => onSelect(edge.target)}>{definitionName(target)} · {target.reference.revision}</button> : <span>{edge.role.targetType.id} / {edge.role.targetType.revision}<span className="mt-1 block text-xs text-muted-foreground">{t('atelier.model.missingDefinition')}</span></span>, cardinality(edge.role.cardinality)];
      })} /></div></details>
    </div>
  </div>;
}

function CandidateRules() {
  const { t } = useTranslation('world');
  const state = useWorldStore();
  const [selected, setSelected] = useState('');
  const rules = useMemo(() => {
    const found = new Map<string, Definition>();
    for (const change of state.changes) {
      if (!['proposed', 'validated', 'testing', 'ready'].includes(change.status)) continue;
      for (const operation of change.operations) {
        const definitions = operation.kind === 'create_definition' ? [operation.definition]
          : operation.kind === 'refine_definition' || operation.kind === 'supersede_rule' ? [operation.replacement]
            : operation.kind === 'split_definition' ? operation.replacements : [];
        for (const item of definitions) if (item.body.kind === 'rule') found.set(referenceKey(item.reference), item);
      }
    }
    return [...found.values()];
  }, [state.changes]);
  const reference = rules.find(item => referenceKey(item.reference) === selected)?.reference;
  const request = useMemo(() => ({ reference, world: state.world, translate: t }), [reference, state.world, t]);
  const [read, setRead] = useState<{ request: typeof request; definition: Definition | null; error: string } | null>(null);
  const result = read?.request === request ? read : null;
  const loading = Boolean(reference && state.world && sameWorld(reference.world, state.world) && !result);
  const definition = result?.definition;
  const error = result?.error;
  useEffect(() => {
    let current = true;
    const { reference, world, translate } = request;
    if (reference && world && sameWorld(reference.world, world)) {
      void queryWorld(world, { kind: 'definition', request: { reference } }, 'definition').then(value => {
        if (!current) return;
        if (!value) throw new Error(translate('atelier.review.definitionUnavailable'));
        if (referenceKey(value.reference) !== referenceKey(reference) || value.body.kind !== 'rule') throw new Error(translate('atelier.review.definitionMismatch'));
        setRead({ request, definition: value, error: '' });
      }).catch(error => { if (current) setRead({ request, definition: null, error: error instanceof Error ? error.message : translate('atelier.review.definitionReadError') }); });
    }
    return () => { current = false; };
  }, [request]);
  return <section className="min-w-0 max-w-3xl space-y-5">
    <div className="space-y-2"><h2 className="text-sm font-semibold">{t('atelier.model.candidateRules')}</h2><p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.model.candidateRulesHint')}</p></div>
    {rules.length ? <Field label={t('atelier.model.candidateRules')}><select className={selectClass} value={selected} onChange={event => setSelected(event.target.value)}><option value="">{t('model.selectDescription')}</option>{rules.map(item => <option key={referenceKey(item.reference)} value={referenceKey(item.reference)}>{definitionName(item)} · {item.reference.id} / {item.reference.revision}</option>)}</select></Field> : <p className="text-sm text-muted-foreground">{t('atelier.model.noCandidateRules')}</p>}
    {loading && <p className="text-sm text-muted-foreground" role="status">{t('changes.loading')}</p>}
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    {reference && definition && referenceKey(definition.reference) === selected && <><h3 className="break-words text-base font-semibold">{definitionName(definition)}</h3><RuleEvaluation key={referenceKey(definition.reference)} definition={definition} /></>}
  </section>;
}

export function Definitions() {
  const world = useWorldStore(state => state.world);
  const incarnation = useWorldStore(state => state.description?.incarnation);
  const workspaceVersion = useWorldStore(state => state.workspaceVersion);
  return <DefinitionsWorkbench key={JSON.stringify([world, incarnation, workspaceVersion])} />;
}

function DefinitionsWorkbench() {
  const { t } = useTranslation('world');
  const state = useWorldStore();
  const navigate = useNavigate();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [view, setView] = useState('canvas');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const definition = state.definitions.find(item => referenceKey(item.reference) === selected) ?? (selected ? undefined : state.definitions.find(item => item.body.kind === 'object_type') ?? state.definitions[0]);
  const selection = definition ? referenceKey(definition.reference) : '';
  const catalog = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return state.definitions.filter(item => !term || `${definitionName(item)} ${item.reference.id} ${item.reference.revision} ${item.body.kind} ${t(`model.kinds.${item.body.kind}`)}`.toLocaleLowerCase().includes(term));
  }, [state.definitions, search, t]);
  const [edit, setEdit] = useState<'annotation' | 'scope' | 'deprecate' | 'link'>('annotation');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [aliases, setAliases] = useState('');
  const [scope, setScope] = useState('');
  const [effective, setEffective] = useState('');
  const [reason, setReason] = useState('');
  const [link, setLink] = useState('');
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [taskId, setTaskId] = useState('');
  const [compile, setCompile] = useState<{ context: CompileRequest; value: CompileSelection } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    if (editing && state.world && definition) void queryWorld(state.world, { kind: 'tasks', request: { scope: definition.scope, page: { limit: 100, cursor: null } } }, 'tasks')
      .then(page => { if (current) setTasks(page.items); }, error => { if (current) setError(error instanceof Error ? error.message : t('model.errors.tasks')); });
    return () => { current = false; };
  }, [state.world, definition, editing, t]);
  const selectDefinition = (id: string) => {
    setSelected(id); setEditing(false); setEvaluating(false); setEvidenceOpen(false); setLabel(''); setDescription(''); setAliases(''); setScope(''); setEffective(''); setReason(''); setLink(''); setCompile(null); setTasks([]); setTaskId(''); setError('');
  };
  const task = tasks.find(item => item.reference.id === taskId);
  const context = state.description?.editingContext;
  const submit = async () => {
    if (!definition || !task || !context || compile?.context !== context || !state.world || !sameWorld(context.world, state.world)) return;
    try {
      let operation: SemanticOperation;
      switch (edit) {
      case 'annotation': operation = { kind: 'enrich_annotation', target: definition.reference, annotation: { label: label.trim() || null, description: description.trim() || null, aliases: aliases.split('\n').map(item => item.trim()).filter(Boolean) } }; break;
      case 'scope': operation = { kind: 'scope_definition', previous: definition.reference, scope, validTime: definition.validTime }; break;
      case 'deprecate': operation = { kind: 'deprecate_definition', previous: definition.reference, effectiveAt: new Date(effective).toISOString(), reason, replacements: [] }; break;
      case 'link': {
        const target = state.definitions.find(item => referenceKey(item.reference) === link);
        if (!target) return;
        operation = { kind: 'link_existing', source: definition.reference, target: target.reference, relation: 'depends_on' }; break;
      }
      }
      const result = await state.command({ kind: 'propose_change', request: { baseRelease: context.baseRelease, operations: [operation], evidence: definition.evidence, cases: [], task: task.reference, compile: compile.value } });
      if (result.kind === 'accepted') navigate('/world/changes');
    } catch (error) { setError(error instanceof Error ? error.message : t('model.errors.submit')); }
  };
  const toggleEditing = () => {
    setEditing(!editing); setEvaluating(false); setView('definition'); setEvidenceOpen(false); setTasks([]); setTaskId(''); setError('');
  };
  const toggleEvaluation = () => {
    setEvaluating(!evaluating); setEditing(false); setView('definition'); setEvidenceOpen(false); setError('');
  };
  return <Tabs value={view} onValueChange={setView} className="world-data-tabs">
    <TabsList variant="line" aria-label={t('model.title')}><TabsTrigger value="canvas">{t('atelier.model.canvas')}</TabsTrigger><TabsTrigger value="definition">{t('atelier.model.definition')}</TabsTrigger><TabsTrigger value="version">{t('atelier.model.version')}</TabsTrigger><TabsTrigger value="authoring">{t('atelier.model.authoring')}</TabsTrigger><TabsTrigger value="candidate-rules">{t('atelier.model.candidateRules')}</TabsTrigger></TabsList>
    <div className="world-atelier-content space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs tabular-nums text-muted-foreground">{t('atelier.model.loadedDefinitions', { count: state.definitions.length })}</span><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => setView('authoring')}><Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />{t('atelier.model.authoring')}</Button><Button size="sm" variant="outline" onClick={() => navigate('/world?tab=materials&mode=upload')}>{t('atelier.model.createFromMaterials')}</Button><Button size="sm" variant="ghost" onClick={() => navigate('/world/changes')}><GitBranch className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />{t('atelier.model.reviewChanges')}</Button></div></div>
    <div className="world-panel world-studio-layout">
      <aside className="world-catalog">
        <h2 className="mb-4 px-1 text-sm font-semibold">{t('atelier.model.catalog')}</h2>
        <div className="relative mb-3"><Search className="pointer-events-none absolute left-2.5 top-3 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /><Input type="search" className="h-9 pl-8 pr-8 text-xs [&::-webkit-search-cancel-button]:appearance-none" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('atelier.model.search')} aria-label={t('atelier.model.search')} />{search && <Button type="button" size="icon" variant="ghost" className="absolute right-0.5 top-0.5 h-8 w-7" aria-label={t('atelier.model.clearSearch')} onClick={() => setSearch('')}><X className="h-3.5 w-3.5" aria-hidden="true" /></Button>}</div>
        {search.trim() && <p className="mb-3 px-1 text-xs tabular-nums text-muted-foreground" role="status">{t('atelier.model.matches', { shown: catalog.length, total: state.definitions.length })}</p>}
        <nav aria-label={t('atelier.model.catalog')} className="space-y-2">{kinds.map(kind => {
          const items = catalog.filter(item => item.body.kind === kind);
          if (!items.length) return null;
          const expanded = Boolean(search.trim()) || kind === 'object_type' || kind === 'relation_type' || items.some(item => referenceKey(item.reference) === selection);
          return <details key={kind} open={expanded} className="group"><summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"><ChevronDown className="h-3.5 w-3.5 shrink-0 -rotate-90 group-open:rotate-0" aria-hidden="true" /><span className="min-w-0 flex-1">{t(`model.kinds.${kind}`)}</span><span className="tabular-nums">{items.length}</span></summary><div className="space-y-0.5">{items.map(item => { const key = referenceKey(item.reference); const Icon = kind === 'object_type' ? Box : kind === 'relation_type' ? Share2 : Braces; return <button key={key} className="world-type-button" type="button" aria-pressed={selection === key} onClick={() => selectDefinition(key)} title={`${definitionName(item)} · ${item.reference.id} / ${item.reference.revision}`}><Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1"><span className={`block truncate text-sm ${selection === key ? 'font-medium' : ''}`}>{definitionName(item)}</span><span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">{item.reference.id} / {item.reference.revision}</span></span></button>; })}</div></details>;
        })}</nav>
        {!catalog.length && <p className="px-2 py-5 text-xs leading-relaxed text-muted-foreground">{t(state.definitions.length ? 'atelier.model.noMatches' : 'model.empty')}</p>}
      </aside>
      <section className="min-w-0" aria-label={t('model.title')}>
          <TabsContent value="canvas" className="mt-0"><SchemaCanvas definitions={state.definitions} selected={selection} onSelect={selectDefinition} /></TabsContent>
          <TabsContent value="definition" className="mt-0">
            <div className="world-panel-body">{definition ? <>
              <header className="mb-6 space-y-3"><p className="text-xs text-muted-foreground">{t(`model.kinds.${definition.body.kind}`)} · {definition.reference.revision}</p><div className="flex flex-wrap items-start justify-between gap-3"><h2 className="min-w-0 break-words text-lg font-semibold">{definitionName(definition)}</h2><div className="flex flex-wrap gap-2">{definition.body.kind === 'rule' && <Button size="sm" variant="outline" aria-expanded={evaluating} onClick={toggleEvaluation}>{t(evaluating ? 'atelier.model.closeEvaluation' : 'atelier.model.evaluateRule')}</Button>}<Button size="sm" variant="outline" aria-expanded={editing} onClick={toggleEditing}>{editing ? t('model.cancelEdit') : definition.body.kind === 'rule' ? t('model.editRule') : t('model.proposeEdit')}</Button></div></div></header>
              {evaluating && definition.body.kind === 'rule' ? <RuleEvaluation definition={definition} /> : editing ? <form className="grid min-w-0 max-w-3xl gap-4" onSubmit={event => { event.preventDefault(); void submit(); }}><h3 className="text-sm font-medium">{t('model.proposeEdit')}</h3>
                <Field label={t('model.edit.method')}><select className={selectClass} value={edit} onChange={event => setEdit(event.target.value as typeof edit)}><option value="annotation">{t('model.edit.annotation')}</option><option value="scope">{t('model.edit.scope')}</option><option value="deprecate">{t('model.edit.deprecate')}</option><option value="link">{t('model.edit.link')}</option></select></Field>
                {edit === 'annotation' && <><TextField label={t('model.edit.name')} value={label} onChange={setLabel} required={false} /><Field label={t('model.edit.description')}><textarea className={`${selectClass} min-h-24 py-2`} value={description} onChange={event => setDescription(event.target.value)} /></Field><Field label={t('model.edit.aliases')}><textarea className={`${selectClass} min-h-20 py-2`} value={aliases} onChange={event => setAliases(event.target.value)} /></Field></>}
                {edit === 'scope' && <Field label={t('model.edit.targetScope')}><select className={selectClass} required value={scope} onChange={event => setScope(event.target.value)}><option value="">{t('model.edit.selectScope')}</option>{context?.scopes.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></Field>}
                {edit === 'deprecate' && <><TextField label={t('model.edit.effectiveAt')} type="datetime-local" value={effective} onChange={setEffective} /><TextField label={t('model.edit.reason')} value={reason} onChange={setReason} /></>}
                {edit === 'link' && <Field label={t('model.edit.dependency')}><select required className={selectClass} value={link} onChange={event => setLink(event.target.value)}><option value="">{t('model.edit.selectDependency')}</option>{state.definitions.filter(item => item.reference.id !== definition.reference.id).map(item => <option key={referenceKey(item.reference)} value={referenceKey(item.reference)}>{definitionName(item)} · {item.reference.revision}</option>)}</select></Field>}
                <Field label={t('model.edit.task')}><select className={selectClass} required value={taskId} onChange={event => setTaskId(event.target.value)}><option value="">{t('model.edit.selectTask')}</option>{tasks.map(item => <option key={item.reference.id} value={item.reference.id}>{item.goal} · {item.reference.revision}</option>)}</select></Field>
                {context && <CompileSelectionFields key={JSON.stringify(context)} context={context} onChange={value => setCompile(value ? { context, value } : null)} />}
                {!context && <p className="text-sm text-muted-foreground">{t('model.edit.noContext')}</p>}
                {!tasks.length && <p className="text-sm text-muted-foreground">{t('model.edit.noTasks')}</p>}
                <div><Button size="sm" disabled={state.busy || !task || !context || compile?.context !== context || (edit === 'annotation' && !label.trim() && !description.trim() && !aliases.trim())}>{t('model.edit.submit')}</Button></div>
              </form> : <DefinitionDetails definition={definition} />}
            </> : <Empty title={t('model.selectTitle')} description={state.definitions.length ? t('model.selectDescription') : t('model.empty')} />}</div>
          </TabsContent>
          <TabsContent value="version" className="mt-0"><div className="world-panel-body space-y-6">
            <section className="space-y-3"><h2 className="text-sm font-semibold">{t('compile.currentBaseline')}</h2><p className="text-xs leading-relaxed text-muted-foreground">{t('compile.description')}</p>{context ? <><DataTable columns={[t('model.details.field'), t('model.details.value')]} rows={[[t('materials.draft.baseRelease'), context.baseRelease], [t('compile.targetLock'), context.activationLock.id], [t('model.details.digest'), context.configDigest]]} /><details><summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t('model.metadata')}</summary><div className="mt-3"><FixedRecord value={{ world: context.world, activationLock: context.activationLock, targets: context.targets, scopes: context.scopes, externalContracts: context.externalContracts }} /></div></details></> : <p className="text-sm text-muted-foreground">{t('model.edit.noContext')}</p>}</section>
            {definition && <section className="space-y-3 border-t border-border pt-5"><h3 className="text-sm font-semibold">{definitionName(definition)}</h3><DataTable columns={[t('model.details.field'), t('model.details.value')]} rows={[[t('model.details.id'), definition.reference.id], [t('model.details.revision'), definition.reference.revision], [t('model.details.lifecycle'), t(`atelier.model.lifecycle.${definition.lifecycle.kind}`)], [t('model.details.validTime'), `${definition.validTime.from} — ${definition.validTime.to ?? t('model.details.ongoing')}`], [t('model.details.digest'), definition.contentDigest]]} /><FixedRecord value={{ reference: definition.reference, previousRef: definition.previousRef, lifecycle: definition.lifecycle }} /></section>}
            <Button size="sm" variant="outline" onClick={() => navigate('/world/changes')}><GitBranch className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />{t('atelier.model.reviewChanges')}</Button>
            <Tasks key={`${state.world?.tenantId}:${state.world?.worldId}:${state.description?.incarnation}`} />
          </div></TabsContent>
          <TabsContent value="authoring" className="mt-0"><div className="world-panel-body"><ModelAuthoring /></div></TabsContent>
          <TabsContent value="candidate-rules" className="mt-0"><div className="world-panel-body"><CandidateRules key={`${state.description?.incarnation}:${state.description?.revision}`} /></div></TabsContent>
        {error && <p className="mx-5 mb-5 text-sm text-destructive" role="alert">{error}</p>}
      </section>
      <aside className="world-detail-panel" aria-label={t('atelier.model.inspector')}>
        <div className="world-panel-header"><h2 className="text-sm font-semibold">{t('atelier.model.inspector')}</h2></div>
        <div className="world-panel-body space-y-5 [&_dl>div]:!grid-cols-1">{definition ? <>
          <header className="space-y-2"><p className="text-xs text-muted-foreground">{t(`model.kinds.${definition.body.kind}`)}</p><h3 className="break-words text-lg font-semibold tracking-tight">{definitionName(definition)}</h3><p className="break-all font-mono text-xs text-muted-foreground">{definition.reference.id} / {definition.reference.revision}</p><p className="flex flex-wrap items-center gap-2 text-xs"><span className="world-status">{t(`atelier.model.lifecycle.${definition.lifecycle.kind}`)}</span><span className="break-words text-muted-foreground" title={t('model.details.scope')}>{definition.scope}</span></p></header>
          {definition.body.kind === 'object_type' ? <section className="space-y-3"><h3 className="text-xs font-medium text-muted-foreground">{t('model.content.properties')}</h3><ul className="divide-y divide-border">{definition.body.body.properties.map(reference => { const property = state.definitions.find(item => referenceKey(item.reference) === referenceKey(reference)); return <li className="py-2.5" key={referenceKey(reference)}>{property ? <button type="button" className="w-full space-y-1 text-left hover:text-foreground" onClick={() => selectDefinition(referenceKey(reference))}><span className="flex items-start justify-between gap-2 text-sm"><span className="break-words font-medium">{definitionName(property)}</span><ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /></span><span className="block break-all text-xs text-muted-foreground">{reference.id} / {reference.revision}</span>{property.body.kind === 'property' && <span className="block text-xs text-muted-foreground">{valueTypeText(t, property.body.body.valueType)} · {property.body.body.cardinality.minimum}..{property.body.body.cardinality.maximum ?? '∞'}{property.body.body.nullable ? ` · ${t('model.content.nullable')}` : ''}</span>}</button> : <p className="break-all text-xs text-muted-foreground">{reference.id} / {reference.revision}<span className="mt-1 block">{t('atelier.model.missingDefinition')}</span></p>}</li>; })}</ul>{!definition.body.body.properties.length && <p className="text-sm text-muted-foreground">{t('model.record.none')}</p>}{definition.body.body.sourceBindings.length > 0 && <div className="space-y-2 border-t border-border pt-4"><h3 className="text-xs font-medium text-muted-foreground">{t('model.content.sources')}</h3>{definition.body.body.sourceBindings.map(reference => <p key={referenceKey(reference)} className="break-all text-xs">{reference.id} / {reference.revision}</p>)}</div>}</section>
            : definition.body.kind === 'relation_type' ? <section className="space-y-4"><h3 className="text-xs font-medium text-muted-foreground">{t('atelier.model.roles')}</h3>{definition.body.body.roles.map(role => { const target = state.definitions.find(item => referenceKey(item.reference) === referenceKey(role.targetType)); return <div key={role.id} className="space-y-1.5 border-b border-border pb-3"><p className="flex flex-wrap justify-between gap-x-3 text-sm font-medium"><span>{role.name}</span><span className="font-normal tabular-nums text-muted-foreground">{role.cardinality.minimum}..{role.cardinality.maximum ?? '∞'}</span></p><p className="break-all text-xs text-muted-foreground">{role.id}</p>{target ? <button type="button" className="break-words text-left text-xs underline decoration-border underline-offset-4" onClick={() => selectDefinition(referenceKey(target.reference))}>{definitionName(target)} / {target.reference.revision}</button> : <p className="break-words text-xs text-muted-foreground">{role.targetType.id} / {role.targetType.revision}<br />{t('atelier.model.missingDefinition')}</p>}</div>; })}</section> : <DefinitionContent definition={definition} />}
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">{definition.body.kind === 'rule' && <Button size="sm" variant="outline" aria-expanded={evaluating} onClick={toggleEvaluation}>{t(evaluating ? 'atelier.model.closeEvaluation' : 'atelier.model.evaluateRule')}</Button>}<Button size="sm" variant="outline" aria-expanded={editing} onClick={toggleEditing}>{editing ? t('model.cancelEdit') : definition.body.kind === 'rule' ? t('model.editRule') : t('model.proposeEdit')}</Button><Button size="sm" variant="ghost" aria-expanded={evidenceOpen} onClick={() => setEvidenceOpen(!evidenceOpen)}>{t('model.evidence')}</Button></div>
          {evidenceOpen && <section className="space-y-4 border-t border-border pt-4"><DataTable columns={[t('model.details.dependency'), t('model.details.revision')]} rows={definition.dependencies.map(reference => [reference.id, reference.revision])} empty={t('model.details.noDependencies')} /><DataTable columns={[t('model.details.evidence'), t('model.details.revision')]} rows={definition.evidence.map(reference => [reference.id, reference.revision])} empty={t('model.details.noEvidence')} /></section>}
          <Button size="sm" variant="ghost" className="w-full justify-between" onClick={() => { setEditing(false); setEvaluating(false); setView('definition'); }}>{t('atelier.model.fullDefinition')}<ArrowUpRight className="ml-2 h-3.5 w-3.5" aria-hidden="true" /></Button>
        </> : <Empty title={t('model.selectTitle')} />}</div>
      </aside>
    </div>
    </div>
  </Tabs>;
}
