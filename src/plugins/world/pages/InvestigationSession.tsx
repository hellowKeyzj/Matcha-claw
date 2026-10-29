import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { hostRuntimeEndpointsList, hostSessionList } from '@/lib/host-api';
import { runtimeEndpointsEqual } from '@/types/desktop/runtime-address';
import type { RuntimeEndpointSummary } from '@/types/runtime-topology';
import type { SessionCatalogItem } from '@/types/session/snapshot';
import type { InvestigationSelection } from '@/types/world';
import { Field, selectClass } from './components';

export function InvestigationSession({ disabled, onChange }: { disabled: boolean; onChange(value: InvestigationSelection | null): void }) {
  const { t } = useTranslation('world');
  const [endpoints, setEndpoints] = useState<RuntimeEndpointSummary[]>([]);
  const [endpointId, setEndpointId] = useState('');
  const [sessions, setSessions] = useState<SessionCatalogItem[]>([]);
  const [selected, setSelected] = useState('');
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
  const endpoint = endpoints.find(item => item.id === endpointId);
  useEffect(() => () => { version.current++; }, []);
  const read = async (kind: 'endpoints' | 'sessions') => {
    if (disabled || reading) return;
    const token = ++version.current;
    setReading(true); setError(''); setSessions([]); setSelected(''); onChange(null);
    try {
      if (kind === 'endpoints') {
        setEndpoints([]); setEndpointId('');
        const result = await hostRuntimeEndpointsList();
        if (token !== version.current) return;
        // InvestigationSelection addresses only the Host's two fixed native driver instances.
        setEndpoints(result.endpoints.filter(item => item.endpointRef.kind === 'native-runtime'
          && item.endpointRef.runtimeInstanceId === 'local'
          && (item.endpointRef.runtimeAdapterId === 'openclaw' || item.endpointRef.runtimeAdapterId === 'matcha-agent')
          && item.location.kind === 'local' && item.source.kind === 'runtime-adapter' && item.lifecycle.ready));
      } else if (endpoint) {
        const result = await hostSessionList({ endpoint: endpoint.endpointRef });
        if (token !== version.current) return;
        if (!result.ready || result.error) throw new Error(result.error || t('resolution.sessionUnavailable'));
        setSessions(result.sessions.filter(item => item.endpointSessionId && item.agentId
          && item.status !== 'deleted' && item.status !== 'archived'
          && item.sessionIdentity.agentId === item.agentId && item.sessionIdentity.sessionKey
          && runtimeEndpointsEqual(item.sessionIdentity.endpoint, endpoint.endpointRef)));
      }
    } catch (error) { if (token === version.current) setError(error instanceof Error ? error.message : t('resolution.sessionUnavailable')); }
    finally { if (token === version.current) setReading(false); }
  };
  const choose = (key: string) => {
    setSelected(key); onChange(null);
    const session = sessions.find(item => JSON.stringify(item.sessionIdentity) === key);
    if (!session?.endpointSessionId || !endpoint || endpoint.endpointRef.kind !== 'native-runtime') return;
    // Both native catalog producers project their actual native session ID into endpointSessionId.
    if (endpoint.endpointRef.runtimeAdapterId === 'openclaw') onChange({ kind: 'openclaw', agentId: session.agentId, sessionKey: session.sessionIdentity.sessionKey, nativeSessionId: session.endpointSessionId });
    if (endpoint.endpointRef.runtimeAdapterId === 'matcha-agent') onChange({ kind: 'matcha_agent', agentId: session.agentId, nativeSessionId: session.endpointSessionId });
  };
  return <fieldset className="min-w-0 space-y-4 border-t border-border pt-5"><legend className="pr-2 text-sm font-semibold">{t('resolution.session')}</legend>
    <div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><Field label={t('resolution.endpoint')}><select className={selectClass} value={endpointId} disabled={disabled || reading} onChange={event => { version.current++; setEndpointId(event.target.value); setSessions([]); setSelected(''); onChange(null); }}><option value="">{t('packages.select')}</option>{endpoints.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></Field></div><Button type="button" size="sm" variant="outline" disabled={disabled || reading} onClick={() => { void read('endpoints'); }}>{t('resolution.readEndpoints')}</Button></div>
    <div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><Field label={t('resolution.session')}><select className={selectClass} value={selected} disabled={disabled || reading || !endpoint} onChange={event => choose(event.target.value)}><option value="">{t('packages.select')}</option>{sessions.map(item => <option key={JSON.stringify(item.sessionIdentity)} value={JSON.stringify(item.sessionIdentity)}>{item.displayName || item.label || item.endpointSessionId} · {item.agentId} · {item.endpointSessionId}</option>)}</select></Field></div><Button type="button" size="sm" variant="outline" disabled={disabled || reading || !endpoint} onClick={() => { void read('sessions'); }}>{t('resolution.readSessions')}</Button></div>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('resolution.sessionNotice')}</p>
    {selected && <p className="break-all font-mono text-xs text-muted-foreground" role="status">{sessions.find(item => JSON.stringify(item.sessionIdentity) === selected)?.sessionIdentity.sessionKey}</p>}
    {reading && <p className="text-xs text-muted-foreground" role="status">{t('shell.reading')}</p>}
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
  </fieldset>;
}
