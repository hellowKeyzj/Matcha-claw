import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Box, ChevronLeft, ChevronRight, FileSearch, GitBranch, Maximize2, Minus, Plus, Search, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWorldStore } from '../store';
import { sameWorld } from '../store/client';
import type { Definition, ObjectView } from '@/types/world';
import { DataTable, Empty, Inspector, cellText, definitionName, selectClass } from './components';
import { DefinitionDetails, FixedRecord } from './Definitions';

export function Objects({ addMaterials, proposeAction }: { addMaterials(mode: 'upload' | 'wiki' | 'connection'): void; proposeAction(object: ObjectView): void }) {
  const world = useWorldStore(state => state.world);
  return <ObjectsView key={JSON.stringify(world)} addMaterials={addMaterials} proposeAction={proposeAction} />;
}

function ObjectsView({ addMaterials, proposeAction }: { addMaterials(mode: 'upload' | 'wiki' | 'connection'): void; proposeAction(object: ObjectView): void }) {
  const { t } = useTranslation('world');
  const state = useWorldStore();
  const navigate = useNavigate();
  const [showRelations, setShowRelations] = useState(false);
  const [graphTypeId, setGraphTypeId] = useState('');
  const [graphRelationId, setGraphRelationId] = useState('');
  const [graphRoleId, setGraphRoleId] = useState('');
  const [connectionPage, setConnectionPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const [evidenceProperty, setEvidenceProperty] = useState<string | null>(null);
  const evidenceId = useId();
  const relationsId = useId();
  const types = state.definitions.filter(item => item.body.kind === 'object_type');
  const fields = state.selectedType?.body.kind === 'object_type' ? state.selectedType.body.body.properties : [];
  const label = (id: string) => {
    const definition = state.definitions.find(item => item.reference.id === id);
    return definition ? definitionName(definition) : id;
  };
  const rows = state.objects?.objects.filter(item => !search
    || item.object.id.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    || item.fields.some(field => cellText(field.cell).toLocaleLowerCase().includes(search.toLocaleLowerCase()))) ?? [];
  const selected = selectedId === null ? undefined : rows.find(item => item.object.id === selectedId) ?? rows[0];
  const selectObject = (id: string) => { setSelectedId(id); setEvidenceProperty(null); };
  const readObjects = (type: Definition, cursor?: string) => {
    setSelectedId(undefined);
    setEvidenceProperty(null);
    void state.loadObjects(type, cursor);
  };
  const typeButtons = types.map(type => (
    <button
      key={`${type.reference.id}:${type.reference.revision}`}
      type="button"
      className="world-type-button"
      aria-pressed={state.selectedType?.reference.id === type.reference.id}
      onClick={() => readObjects(type)}
    >
      <span className="truncate">{definitionName(type)}</span>
    </button>
  ));
  const addButtons = (
    <>
      <Button size="sm" variant="ghost" type="button" onClick={() => addMaterials('wiki')}>{t('data.importWiki')}</Button>
      <Button size="sm" variant="outline" type="button" onClick={() => addMaterials('connection')}>{t('data.connect')}</Button>
      <Button size="sm" type="button" onClick={() => addMaterials('upload')}>
        <Upload className="mr-2 h-4 w-4" aria-hidden="true" />{t('data.upload')}
      </Button>
    </>
  );
  const center = types.find(item => item.reference.id === graphTypeId)
    ?? types.find(item => item.reference.id === state.selectedType?.reference.id) ?? types[0];
  const relationTypes = state.definitions.filter(item => item.body.kind === 'relation_type');
  const relatedRelations = relationTypes.filter(item => item.body.kind === 'relation_type' && item.body.body.roles.some(role => center
    && role.targetType.id === center.reference.id && role.targetType.revision === center.reference.revision
    && sameWorld(role.targetType.world, center.reference.world)));
  const connections = relatedRelations.flatMap(definition => {
    if (definition.body.kind !== 'relation_type') return [];
    const roles = definition.body.body.roles;
    const origin = roles.find(role => center && role.targetType.id === center.reference.id
      && role.targetType.revision === center.reference.revision && sameWorld(role.targetType.world, center.reference.world));
    return roles.filter(role => roles.length === 1 || role !== origin).map(role => ({ definition, role }));
  });
  const graphPage = Math.min(connectionPage, Math.max(0, Math.ceil(connections.length / 6) - 1));
  const visibleConnections = connections.slice(graphPage * 6, graphPage * 6 + 6);
  const graphRelation = relatedRelations.find(item => item.reference.id === graphRelationId);
  const graphRole = graphRelation?.body.kind === 'relation_type' ? graphRelation.body.body.roles.find(role => role.id === graphRoleId) : undefined;
  const graphTarget = graphRole && types.find(item => item.reference.id === graphRole.targetType.id
    && item.reference.revision === graphRole.targetType.revision && sameWorld(item.reference.world, graphRole.targetType.world));
  const positions = [{ x: 152, y: 84 }, { x: 708, y: 84 }, { x: 118, y: 215 }, { x: 742, y: 215 }, { x: 152, y: 346 }, { x: 708, y: 346 }];
  const pendingChanges = state.changes.filter(item => state.world && sameWorld(item.world, state.world)
    && item.status !== 'published' && item.status !== 'rejected' && item.status !== 'superseded');
  const openBrowse = (type = center) => {
    setShowRelations(false);
    if (type && (state.selectedType?.reference.id !== type.reference.id || state.selectedType.reference.revision !== type.reference.revision || !state.objects)) readObjects(type);
  };
  const chooseGraphType = (id: string) => { setGraphTypeId(id); setGraphRelationId(''); setGraphRoleId(''); setConnectionPage(0); };
  const chooseGraphRelation = (id: string, role: string) => { setGraphRelationId(id); setGraphRoleId(role); };
  return (
    <div className="world-atelier-content world-object-workspace space-y-5">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h2 className="flex min-w-0 items-center gap-3 text-base font-semibold tracking-tight"><Box className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />{t('data.browseTitle')}</h2>
        <div className="flex flex-wrap items-center gap-2">{addButtons}</div>
      </header>
      <div className="world-object-toolbar">
        <div className="world-type-strip" role="group" aria-label={t('data.objectType')}>{typeButtons.length ? typeButtons : <span className="px-3 py-1 text-xs text-muted-foreground">{t('data.objectType')}</span>}</div>
        <form className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2" onSubmit={event => {
          event.preventDefault();
          const type = state.selectedType ?? center;
          if (type) readObjects(type);
        }}>
          <div className="relative min-w-0 max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              className="h-9 pl-9 text-sm"
              placeholder={t('data.search')}
              aria-label={t('data.search')}
              value={search}
              onChange={event => { setSearch(event.target.value); setEvidenceProperty(null); }}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={!types.length}>{t('atelier.overview.runQuery')}</Button>
          <Button type="button" size="sm" variant="ghost" aria-expanded={showRelations} aria-controls={relationsId} onClick={() => setShowRelations(value => !value)}>
            <GitBranch className="mr-2 h-4 w-4" aria-hidden="true" />{t('data.relationsOverview')}
          </Button>
        </form>
      </div>
      {showRelations && <section id={relationsId} className="world-panel min-w-0 overflow-hidden" aria-label={t('atelier.overview.relationsTitle')}>
        <header className="world-panel-header flex-wrap gap-3">
          <h2>{t('atelier.overview.relationsTitle')}</h2>
          <div className="flex min-w-0 items-center gap-2">
            <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><span className="shrink-0">{t('data.objectType')}</span><select className={`${selectClass} h-8 max-w-48`} value={center?.reference.id ?? ''} onChange={event => chooseGraphType(event.target.value)} disabled={!types.length}>{!types.length && <option value="">{t('data.selectType')}</option>}{types.map(type => <option key={`${type.reference.id}:${type.reference.revision}`} value={type.reference.id}>{definitionName(type)}</option>)}</select></label>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={t('shared.close')} onClick={() => setShowRelations(false)}><X className="h-4 w-4" aria-hidden="true" /></Button>
          </div>
        </header>
        <div className="world-canvas">
          <p className="px-5 pt-4 text-xs text-muted-foreground">{t('data.schemaRelations')}</p>
          {center ? <div className="max-w-full overflow-auto" tabIndex={0} aria-label={t('atelier.overview.relationsTitle')}>
            <svg width={860 * zoom} height={430 * zoom} viewBox="0 0 860 430" className="mx-auto block max-w-none" role="group" aria-label={t('atelier.overview.relationsTitle')}>
              <circle cx="430" cy="215" r="146" fill="hsl(var(--ring) / 0.025)" stroke="hsl(var(--shell-border))" strokeDasharray="2 8" />
              <circle cx="430" cy="215" r="94" fill="hsl(var(--ring) / 0.035)" stroke="hsl(var(--ring) / 0.12)" />
              {visibleConnections.map((connection, index) => {
                const { x, y } = positions[index];
                const left = x < 430;
                const startX = left ? 370 : 490;
                const endX = x + (left ? 85 : -85);
                const midX = (startX + endX) / 2;
                const midY = (215 + y) / 2;
                const name = definitionName(connection.definition);
                return <g key={`${connection.definition.reference.id}:${connection.definition.reference.revision}:${connection.role.id}`}>
                  <path d={`M ${startX} 215 C ${midX} 215 ${midX} ${y} ${endX} ${y}`} fill="none" stroke={graphRelation?.reference.id === connection.definition.reference.id ? 'hsl(var(--ring))' : 'hsl(var(--muted-foreground) / 0.5)'} strokeWidth="1.5" />
                  <rect x={midX - 62} y={midY - 11} width="124" height="22" rx="4" fill="hsl(var(--shell-surface))" />
                  <text x={midX} y={midY + 4} textAnchor="middle" fill="hsl(var(--muted-foreground))" fontSize="12"><title>{name} · {connection.role.name}</title>{name.length > 12 ? `${name.slice(0, 11)}…` : name}</text>
                </g>;
              })}
              <foreignObject x="370" y="155" width="120" height="120">
                <button type="button" className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-full border border-ring/60 bg-[hsl(var(--shell-surface))] px-3 text-center text-sm font-semibold shadow-sm hover:bg-[hsl(var(--shell-surface-muted))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" title={definitionName(center)} onClick={() => openBrowse(center)}><Box className="h-6 w-6 shrink-0" aria-hidden="true" /><span className="line-clamp-2 max-w-full break-words">{definitionName(center)}</span></button>
              </foreignObject>
              {visibleConnections.map((connection, index) => {
                const { x, y } = positions[index];
                const target = state.definitions.find(item => item.reference.id === connection.role.targetType.id && item.reference.revision === connection.role.targetType.revision && sameWorld(item.reference.world, connection.role.targetType.world));
                const targetName = target ? definitionName(target) : connection.role.targetType.id;
                const name = definitionName(connection.definition);
                return <foreignObject key={`${connection.definition.reference.id}:${connection.definition.reference.revision}:${connection.role.id}`} x={x - 85} y={y - 36} width="170" height="72">
                  <button type="button" className={`flex h-full w-full items-center gap-3 rounded-lg border bg-[hsl(var(--shell-surface))] px-3 text-left hover:bg-[hsl(var(--shell-surface-muted))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${graphRelation?.reference.id === connection.definition.reference.id ? 'border-ring' : 'border-[hsl(var(--shell-border))]'}`} aria-pressed={graphRelation?.reference.id === connection.definition.reference.id && graphRoleId === connection.role.id} aria-label={`${targetName} · ${name} · ${connection.role.name}`} title={`${targetName} · ${name} · ${connection.role.name}`} onClick={() => chooseGraphRelation(connection.definition.reference.id, connection.role.id)}>
                    <Box className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{targetName}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{connection.role.name}</span></span>
                  </button>
                </foreignObject>;
              })}
            </svg>
          </div> : <Empty icon={<GitBranch className="h-9 w-9" strokeWidth={1.25} />} description={t('atelier.overview.graphEmpty')} />}
          {center && <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-4">
            <div className="flex items-center gap-1 rounded-lg border border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface))] p-1">
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={t('atelier.overview.zoomOut')} disabled={zoom <= 0.75} onClick={() => setZoom(value => Math.max(0.75, value - 0.25))}><Minus className="h-3.5 w-3.5" aria-hidden="true" /></Button>
              <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={t('atelier.overview.zoomIn')} disabled={zoom >= 1.5} onClick={() => setZoom(value => Math.min(1.5, value + 0.25))}><Plus className="h-3.5 w-3.5" aria-hidden="true" /></Button>
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={t('atelier.overview.resetZoom')} onClick={() => setZoom(1)}><Maximize2 className="h-3.5 w-3.5" aria-hidden="true" /></Button>
            </div>
            {!!connections.length && <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{t('atelier.overview.graphWindow', { from: graphPage * 6 + 1, to: Math.min(graphPage * 6 + 6, connections.length), value: connections.length })}</span><Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={t('atelier.overview.previousConnections')} disabled={graphPage === 0} onClick={() => setConnectionPage(graphPage - 1)}><ChevronLeft className="h-4 w-4" aria-hidden="true" /></Button><Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={t('atelier.overview.nextConnections')} disabled={(graphPage + 1) * 6 >= connections.length} onClick={() => setConnectionPage(graphPage + 1)}><ChevronRight className="h-4 w-4" aria-hidden="true" /></Button></div>}
          </div>}
        </div>
        {center && <div className="border-t border-[hsl(var(--shell-border))] px-5 py-4" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{t('atelier.overview.selectedType', { name: definitionName(center) })}</p><p className="mt-1 text-xs text-muted-foreground">{t('atelier.overview.schemaSummary', { properties: center.body.kind === 'object_type' ? center.body.body.properties.length : 0, relations: relatedRelations.length })}</p></div><Button type="button" variant="ghost" size="sm" onClick={() => navigate('/world/model')}>{t('changes.goModel')}<ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /></Button></div>
          {graphRelation && <div className="mt-4 border-t border-[hsl(var(--shell-border))] pt-4"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h3 className="break-words text-sm font-semibold">{definitionName(graphRelation)}</h3>{graphRole && <p className="mt-1 break-words text-xs text-muted-foreground">{graphRole.name} · {graphTarget ? definitionName(graphTarget) : graphRole.targetType.id} · {graphRole.targetType.revision}</p>}</div><div className="flex shrink-0 items-center gap-2">{graphTarget && <Button type="button" variant="outline" size="sm" onClick={() => { chooseGraphType(graphTarget.reference.id); openBrowse(graphTarget); }}>{t('atelier.overview.browse')}<ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /></Button>}<Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={t('shared.close')} onClick={() => setGraphRelationId('')}><X className="h-4 w-4" aria-hidden="true" /></Button></div></div><div className="max-h-72 overflow-auto"><DefinitionDetails definition={graphRelation} /></div></div>}
          {!!connections.length && <details className="mt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">{t('model.content.roles')}</summary><div className="mt-3"><DataTable columns={[t('model.kinds.relation_type'), t('model.content.roles'), t('data.objectType')]} rows={connections.map(connection => {
            const target = types.find(type => type.reference.id === connection.role.targetType.id && type.reference.revision === connection.role.targetType.revision && sameWorld(type.reference.world, connection.role.targetType.world));
            return [<button type="button" className="text-left font-medium text-foreground hover:underline" onClick={() => chooseGraphRelation(connection.definition.reference.id, connection.role.id)}>{definitionName(connection.definition)}</button>, connection.role.name, target ? <button type="button" className="text-left text-foreground hover:underline" onClick={() => { chooseGraphType(target.reference.id); openBrowse(target); }}>{definitionName(target)}</button> : `${connection.role.targetType.id} · ${connection.role.targetType.revision}`];
          })} /></div></details>}
        </div>}
      </section>}
      <div className="world-overview-layout">
        <section className="world-panel overflow-hidden last:col-span-full" aria-label={t('data.title')}>
          <header className="world-panel-header">
            <h2>{state.selectedType ? definitionName(state.selectedType) : t('data.objectType')}</h2>
            {state.objects && <span className="text-xs text-muted-foreground">{t('atelier.overview.pageObjects', { value: state.objects.objects.length })}</span>}
          </header>
          {!types.length || !state.selectedType || !rows.length ? (
            <Empty
              icon={<Box className="h-9 w-9" strokeWidth={1.25} />}
              description={!types.length ? t('data.noTypes') : !state.selectedType ? t('data.chooseType')
                : !state.objects ? state.error ? t('shell.readFailed') : t('data.reading')
                  : search ? t('data.noMatches') : t('data.noObjects')}
              action={!types.length ? <Button type="button" variant="outline" size="sm" onClick={() => navigate('/world/model')}>{t('changes.goModel')}</Button> : undefined}
            />
          ) : (
            <DataTable
              columns={[t('data.object'), ...fields.map(property => label(property.id))]}
              rowKeys={rows.map(item => item.object.id)}
              selectedRowKey={selected?.object.id}
              onRowSelect={selectObject}
              rows={rows.map(item => [
                <button type="button" title={item.object.id} className="flex max-w-64 items-center gap-3 text-left" onClick={() => selectObject(item.object.id)}>
                  <Box className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate font-medium">{item.object.id}</span>
                </button>,
                ...fields.map(property => {
                  const field = item.fields.find(field => field.property.id === property.id);
                  return field ? cellText(field.cell) : t('data.unobserved');
                }),
              ])}
            />
          )}
          {state.objects && <footer className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--shell-border))] px-5 py-3">
            <span className="text-xs text-muted-foreground">{t('data.pageResults', { shown: rows.length, loaded: state.objects.objects.length })}</span>
            {state.objects.rows.nextCursor && <Button type="button" variant="outline" size="sm" onClick={() => {
              if (state.selectedType) readObjects(state.selectedType, state.objects?.rows.nextCursor ?? undefined);
            }}>{t('data.nextPage')}<ChevronRight className="ml-2 h-4 w-4" aria-hidden="true" /></Button>}
          </footer>}
        </section>
        {rows.length > 0 && <div className="world-panel world-object-detail overflow-hidden">
          {!selected ? <Empty icon={<FileSearch className="h-7 w-7" strokeWidth={1.25} />} title={t('data.selectObject')} /> : (
            <Inspector title={t('data.detail')} description={state.selectedType ? definitionName(state.selectedType) : undefined} onClose={() => { setSelectedId(null); setEvidenceProperty(null); }}>
              <h3 className="break-words text-xl font-semibold tracking-tight">{selected.object.id}</h3>
              <dl className="space-y-4">
                {selected.fields.map(field => (
                  <div key={`${field.property.id}:${field.property.revision}`} className="min-w-0 border-b border-[hsl(var(--shell-border))] pb-4">
                    <dt className="mb-2 text-xs text-muted-foreground">{label(field.property.id)}</dt>
                    <dd>
                      <button
                        type="button"
                        className="flex w-full items-start justify-between gap-3 rounded-md text-left text-sm font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={t('data.fieldEvidence', { property: label(field.property.id) })}
                        aria-expanded={evidenceProperty === field.property.id}
                        aria-controls={evidenceProperty === field.property.id ? evidenceId : undefined}
                        onClick={() => setEvidenceProperty(value => value === field.property.id ? null : field.property.id)}
                      >
                        <span className="min-w-0 break-words">{cellText(field.cell)}</span>
                        <FileSearch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      </button>
                      <p className="mt-2 text-xs text-muted-foreground">{field.dirty.kind === 'dirty' ? t('data.dirty') : t('data.checked')}</p>
                      {evidenceProperty === field.property.id && <section id={evidenceId} className="mt-3 space-y-3 rounded-md border border-[hsl(var(--shell-border))] p-3" aria-label={t('data.fieldEvidence', { property: label(field.property.id) })}>
                        <h4 className="text-xs font-medium">{t('data.evidence')}</h4>
                        {field.evidence.length ? <ul className="space-y-2 text-xs text-muted-foreground">{field.evidence.map(evidence => <li key={`${evidence.id}:${evidence.revision}`} className="break-all">{evidence.id} · v{evidence.revision}</li>)}</ul> : <p className="text-xs text-muted-foreground">{t('data.noEvidence')}</p>}
                        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('data.state')}</summary><div className="mt-3"><FixedRecord value={{ cell: field.cell, dirty: field.dirty }} /></div></details>
                        <Button type="button" size="sm" variant="outline" onClick={() => addMaterials('upload')}>{t('atelier.overview.supplementEvidence')}</Button>
                      </section>}
                    </dd>
                  </div>
                ))}
              </dl>
              {state.objects && <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t('data.readReceipt')}</summary>
                <div className="mt-3 space-y-3">
                  <p className="break-all">{selected.receiptId}</p>
                  <p>{state.objects.receipt.coverage.complete ? t('data.complete') : t('data.incomplete')}</p>
                  <FixedRecord value={state.objects.receipt} />
                </div>
              </details>}
              <Button type="button" variant="outline" size="sm" className="w-full" disabled={state.busy} onClick={() => proposeAction(selected)}>{t('data.act')}<ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /></Button>
            </Inspector>
          )}
        </div>}
      </div>
      <section className="world-panel flex min-w-0 flex-wrap items-center justify-between gap-3 px-5 py-4" aria-label={t('atelier.overview.changesTitle')}>
        <div className="flex min-w-0 items-center gap-3"><GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><h2 className="text-sm font-medium">{t('atelier.overview.changesTitle')}</h2><span className="text-xs text-muted-foreground">{t('data.loadedChanges', { value: pendingChanges.length })}</span></div>
        <Button type="button" variant="ghost" size="sm" onClick={() => navigate('/world/changes')}>{t('atelier.overview.reviewChanges')}<ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /></Button>
      </section>
    </div>
  );
}
