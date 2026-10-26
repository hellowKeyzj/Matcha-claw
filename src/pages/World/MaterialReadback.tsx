import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '@/stores/world';
import { queryWorld, sameWorld } from '@/stores/world/client';
import type { ParseArtifact, SourceVersion, SourceVersionRef } from '@/types/world';
import { DataTable, Field, selectClass } from './components';
import { FixedRecord } from './Definitions';

export function MaterialReadback({ sources, artifacts = [] }: { sources: SourceVersionRef[]; artifacts?: string[] }) {
  const { t } = useTranslation('world');
  const state = useWorldStore();
  const [sourceKey, setSourceKey] = useState('');
  const [artifactId, setArtifactId] = useState('');
  const [source, setSource] = useState<SourceVersion | null>(null);
  const [artifact, setArtifact] = useState<ParseArtifact | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
  const signature = JSON.stringify([sources, artifacts, state.world, state.description?.incarnation, state.description?.revision]);
  useEffect(() => { version.current++; setSource(null); setArtifact(null); setReading(false); setError(''); }, [signature]);
  useEffect(() => () => { version.current++; }, []);
  const read = async (kind: 'source' | 'artifact') => {
    if (!state.world || reading) return;
    const world = state.world;
    const incarnation = state.description?.incarnation;
    const revision = state.description?.revision;
    const reference = sources.find(item => JSON.stringify(item) === sourceKey);
    if (kind === 'source' ? !reference : !artifacts.includes(artifactId)) return;
    const token = ++version.current;
    const current = () => {
      const latest = useWorldStore.getState();
      return token === version.current && latest.world && sameWorld(latest.world, world)
        && latest.description?.incarnation === incarnation && latest.description?.revision === revision;
    };
    setReading(true); setError(''); setSource(null); setArtifact(null);
    try {
      if (kind === 'source' && reference) {
        const result = await queryWorld(world, { kind: 'source_version', request: { reference } }, 'source_version');
        if (!current()) return;
        if (!sameWorld(result.reference.world, world) || result.reference.sourceId !== reference.sourceId
          || result.reference.versionId !== reference.versionId) throw new Error(t('materials.readback.mismatch'));
        setSource(result);
      } else {
        const result = await queryWorld(world, { kind: 'parse_artifact', request: { id: artifactId } }, 'parse_artifact');
        if (!current()) return;
        if (!sameWorld(result.world, world) || result.id !== artifactId || !sameWorld(result.sourceVersion.world, world)
          || !sources.some(item => item.sourceId === result.sourceVersion.sourceId && item.versionId === result.sourceVersion.versionId && sameWorld(item.world, world))) throw new Error(t('materials.readback.mismatch'));
        setArtifact(result);
      }
    } catch (error) { if (current()) setError(error instanceof Error ? error.message : t('materials.readback.failed')); }
    finally { if (token === version.current) setReading(false); }
  };
  return <details className="space-y-3 rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('materials.readback.title')}</summary><div className="mt-4 space-y-4">
    <p className="text-xs leading-relaxed text-muted-foreground">{t('materials.readback.notice')}</p>
    {!!sources.length && <div className="space-y-2"><Field label={t('materials.draft.sourceVersions')}><select className={selectClass} disabled={reading} value={sourceKey} onChange={event => { setSourceKey(event.target.value); setSource(null); }}><option value="">{t('packages.select')}</option>{sources.map(item => <option key={JSON.stringify(item)} value={JSON.stringify(item)}>{item.sourceId} · {item.versionId}</option>)}</select></Field><Button type="button" size="sm" variant="outline" disabled={reading || !sources.some(item => JSON.stringify(item) === sourceKey)} onClick={() => { void read('source'); }}>{t('materials.readback.readSource')}</Button></div>}
    {!!artifacts.length && <div className="space-y-2"><Field label={t('materials.draft.parseArtifacts')}><select className={selectClass} disabled={reading} value={artifactId} onChange={event => { setArtifactId(event.target.value); setArtifact(null); }}><option value="">{t('packages.select')}</option>{artifacts.map(id => <option key={id} value={id}>{id}</option>)}</select></Field><Button type="button" size="sm" variant="outline" disabled={reading || !artifacts.includes(artifactId)} onClick={() => { void read('artifact'); }}>{t('materials.readback.readArtifact')}</Button></div>}
    {reading && <p className="text-sm text-muted-foreground" role="status">{t('shell.reading')}</p>}{error && <p className="text-sm text-destructive" role="alert">{error}</p>}{source && <FixedRecord value={source} />}
    {artifact && <div className="space-y-4">
      <FixedRecord value={{ id: artifact.id, sourceVersion: artifact.sourceVersion, parseRun: artifact.parseRun, parserFingerprint: artifact.parserFingerprint, optionsDigest: artifact.optionsDigest }} />
      <DataTable columns={[t('materials.readback.block'), t('materials.readback.content')]} rows={artifact.blocks.map(block => [<span className="break-all text-xs">{block.id}<span className="block text-muted-foreground">{block.kind.kind}</span></span>, <p className="whitespace-pre-wrap break-words">{block.text}</p>])} />
      {artifact.tables.map(table => <section key={table.id} className="space-y-2"><h5 className="break-words text-sm font-medium">{table.name || table.id}</h5><FixedRecord value={table.cells} /></section>)}
      <DataTable columns={[t('materials.draft.coverage'), t('materials.draft.gapReason'), t('materials.draft.location')]} rows={artifact.coverage.map(item => [item.status, item.reason?.kind ?? t('materials.draft.notProvided'), <FixedRecord value={item.anchor} />])} empty={t('materials.draft.noCoverage')} />
      <details><summary className="cursor-pointer text-xs">{t('materials.readback.provenance')}</summary><div className="mt-3"><FixedRecord value={{ sourceMap: artifact.sourceMap, assets: artifact.assets, dependencyFingerprints: artifact.dependencyFingerprints, metadata: artifact.metadata, manifest: artifact.manifest }} /></div></details>
    </div>}
  </div></details>;
}
