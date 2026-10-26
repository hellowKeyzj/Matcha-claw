import { useState } from 'react';
import { Bot, Command, SearchCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { SearchConfig, SearchSnapshot } from '@/types/network-search';
import { Verification } from './Verification';

type Props = { snapshot: SearchSnapshot; draft: SearchConfig; disabled: boolean; onChange: (patch: Partial<SearchConfig>) => void };
const RUNTIMES = [{ id: 'openclaw', name: 'OpenClaw', icon: Bot }, { id: 'matcha-agent', name: 'matcha-agent', icon: Command }] as const;

export function Runtimes({ snapshot, draft, disabled, onChange }: Props) {
  const { t } = useTranslation('settings');
  const [verification, setVerification] = useState<string | null>(null);

  return <div className="network-search-runtime-list">
    {RUNTIMES.map(({ id, name, icon: Icon }) => {
      const state = snapshot.runtimes.find((runtime) => runtime.endpoint.runtimeAdapterId === id && runtime.endpoint.runtimeInstanceId === 'local');
      const config = draft.runtimes.find((runtime) => runtime.endpoint.runtimeAdapterId === id && runtime.endpoint.runtimeInstanceId === 'local');
      const enabled = config?.enabled ?? state?.enabled ?? false;
      return <section key={id} className="network-search-runtime" aria-label={name}>
        <div className="network-search-runtime-row">
          <div className="network-search-runtime-identity flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background"><Icon aria-hidden className="h-5 w-5 text-muted-foreground" /></span>
            <h3 className="min-w-0 break-words text-base font-semibold">{name}</h3>
          </div>
          <div className="network-search-runtime-state">
            <Badge role="status" variant={state?.phase === 'ready' ? 'success' : state?.phase === 'failed' ? 'destructive' : state?.phase === 'pendingRestart' ? 'warning' : 'secondary'}>
              {state ? t(`networkSearch.runtimePhase.${state.phase}`) : t('networkSearch.statusUnavailable')}
            </Badge>
          </div>
          <div className="network-search-runtime-controls">
            <Switch disabled={disabled || !state} checked={enabled} aria-label={t('networkSearch.enableRuntime', { name })} onCheckedChange={(next) => {
              if (!state) return;
              onChange({ runtimes: config
                ? draft.runtimes.map((runtime) => runtime === config ? { ...runtime, enabled: next } : runtime)
                : [...draft.runtimes, { endpoint: state.endpoint, enabled: next }] });
            }} />
            <Button type="button" variant="outline" size="sm" disabled={!state} aria-expanded={verification === id} onClick={() => setVerification(verification === id ? null : id)}><SearchCheck aria-hidden className="h-4 w-4" />{t('networkSearch.verifyIntegration')}</Button>
          </div>
        </div>
        {state?.error && <p role="alert" className="network-search-error mb-4">{state.error}</p>}
        {state?.phase === 'pendingRestart' && <p className="mb-4 text-xs text-muted-foreground">{t('networkSearch.pendingRestart')}</p>}
        {verification === id && state && <Verification target={{ endpoint: state.endpoint }} title={t('networkSearch.verifyRuntimeTitle', { name })} revision={snapshot.appliedRevision} disabled={disabled || snapshot.service.phase !== 'running' || !state.enabled} onClose={() => setVerification(null)} />}
      </section>;
    })}
  </div>;
}
