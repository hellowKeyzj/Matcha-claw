import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '../store';
import { queryWorld, sameWorld } from '../store/client';
import type { ConnectionView, SourceCheckpoint, WorldCommand } from '@/types/world';
import { Field, selectClass } from './components';
import { FixedRecord } from './Definitions';
import { useWorldConfirmation } from './WorldConfirmation';

export function SourceSync({ connection }: { connection: ConnectionView }) {
  const { t } = useTranslation('world');
  const confirm = useWorldConfirmation();
  const navigate = useNavigate();
  const state = useWorldStore();
  const [selected, setSelected] = useState('');
  const [checkpoint, setCheckpoint] = useState<SourceCheckpoint | null>(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const version = useRef(0);
  const mounted = useRef(false);
  const bindings = state.definitions.filter(item => item.body.kind === 'source_binding'
    && item.body.body.connectionId === connection.id && item.body.body.connectionRevision === connection.revision
    && item.body.body.sourceId === connection.sourceId);
  const binding = bindings.find(item => JSON.stringify(item.reference) === selected);
  const selection = useRef({ binding, connection });
  selection.current = { binding, connection };
  const blocked = state.loading || state.busy || state.operationBusy || Boolean(state.pending)
    || Boolean(state.pendingOperation) || state.transferBusy || reading;
  useEffect(() => { version.current++; setCheckpoint(null); setError(''); setReading(false); }, [selected, state.description?.revision, state.description?.incarnation]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; }; }, []);
  const run = async (kind: 'read' | 'start_sync' | 'stop_sync') => {
    if (blocked || !binding || !state.world || state.description?.status !== 'ready') return;
    const world = state.world;
    const incarnation = state.description.incarnation;
    const revision = state.description.revision;
    const token = ++version.current;
    const current = () => {
      const latest = useWorldStore.getState();
      return token === version.current && latest.world && sameWorld(latest.world, world)
        && latest.description?.incarnation === incarnation && latest.description?.revision === revision;
    };
    setError(''); setCheckpoint(null); setReading(true);
    try {
      if (kind === 'read') {
        const result = await queryWorld(world, { kind: 'sync_status', request: { binding: binding.reference } }, 'sync_status');
        if (!current()) return;
        if (!sameWorld(result.binding.world, world) || result.binding.id !== binding.reference.id
          || result.binding.revision !== binding.reference.revision) throw new Error(t('connections.sync.mismatch'));
        setCheckpoint(result);
      } else {
        const command: WorldCommand = { kind, request: { binding: binding.reference, expectedRevision: binding.reference.revision } };
        if (!await confirm(t(kind === 'start_sync' ? 'connections.sync.startConfirm' : 'connections.sync.stopConfirm'))
          || !mounted.current || !current() || selection.current.binding !== binding || selection.current.connection !== connection) return;
        const before = useWorldStore.getState();
        if (before.loading || before.busy || before.operationBusy || before.pending || before.pendingOperation || before.transferBusy
          || before.description?.status !== 'ready' || !before.definitions.includes(binding) || !before.connections.includes(connection)) return;
        const result = await before.command(command);
        const latest = useWorldStore.getState();
        if (mounted.current && latest.world && sameWorld(latest.world, world) && latest.description?.incarnation === incarnation && result.kind === 'accepted') navigate('/world/settings?tab=operations');
      }
    } catch (error) { if (current()) setError(error instanceof Error ? error.message : t('connections.sync.failed')); }
    finally { if (token === version.current) setReading(false); }
  };
  return <details className="space-y-3 border-t border-border pt-4"><summary className="cursor-pointer text-sm font-semibold">{t('connections.sync.title')}</summary><p className="text-xs leading-relaxed text-muted-foreground">{t('connections.sync.notice')}</p>
    <Field label={t('connections.sync.binding')}><select className={selectClass} value={selected} disabled={blocked} onChange={event => setSelected(event.target.value)}><option value="">{t('packages.selectBinding')}</option>{bindings.map(item => <option key={JSON.stringify(item.reference)} value={JSON.stringify(item.reference)}>{item.reference.id} · {item.reference.revision}</option>)}</select></Field>
    {!bindings.length && <p className="text-xs text-muted-foreground">{t('connections.sync.noBindings')}</p>}
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={blocked || !binding} onClick={() => { void run('read'); }}>{t('connections.sync.read')}</Button><Button type="button" size="sm" variant="outline" disabled={blocked || !binding} onClick={() => { void run('start_sync'); }}>{t('connections.sync.start')}</Button><Button type="button" size="sm" variant="outline" disabled={blocked || !binding} onClick={() => { void run('stop_sync'); }}>{t('connections.sync.stop')}</Button></div>
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}{checkpoint && <div className="space-y-3"><FixedRecord value={checkpoint} />{checkpoint.gap && <p className="text-sm text-destructive">{t('connections.sync.gap')}</p>}</div>}
  </details>;
}
