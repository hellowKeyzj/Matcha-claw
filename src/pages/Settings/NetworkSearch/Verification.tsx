import { useEffect, useRef, useState } from 'react';
import { Loader2, SearchCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { verifyNetworkSearch } from '@/lib/network-search';
import type { SearchVerification, SearchVerifyRequest } from '@/types/network-search';

type Props = {
  target: Omit<SearchVerifyRequest, 'query'>;
  title: string;
  revision: number | null;
  disabled: boolean;
  onClose?: () => void;
};

export function Verification({ target, title, revision, disabled, onClose }: Props) {
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchVerification | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    setResult(null);
    setError('');
    setPending(false);
    return () => { request.current?.abort(); request.current = null; };
  }, [revision]);

  const verify = async () => {
    if (request.current || !query.trim() || disabled) return;
    const controller = new AbortController();
    request.current = controller;
    setResult(null);
    setError('');
    setPending(true);
    try {
      const response = await verifyNetworkSearch({ ...target, query: query.trim() }, controller.signal);
      if (!controller.signal.aborted) setResult(response);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };
  const hasUnresponsive = result && result.unresponsiveEngines != null
    && (typeof result.unresponsiveEngines === 'object'
      ? Object.keys(result.unresponsiveEngines).length > 0 : Boolean(result.unresponsiveEngines));

  return (
    <section className="network-search-verification min-h-0 overflow-y-auto overscroll-contain" aria-label={title} aria-busy={pending}>
      <div className="flex items-center justify-between gap-3">
        <h4 className="min-w-0 break-words text-sm font-medium">{title}</h4>
        {onClose && <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={onClose} aria-label={t('networkSearch.closeVerification')}><X aria-hidden className="h-4 w-4" /></Button>}
      </div>
      <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void verify(); }}>
        <Input aria-label={t('networkSearch.query')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('networkSearch.query')} required maxLength={1000} disabled={pending} className="h-9 min-w-0 flex-[1_1_180px] text-sm" />
        <Button type="submit" size="sm" disabled={disabled || pending || !query.trim()} className="h-9">
          {pending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <SearchCheck aria-hidden className="h-4 w-4" />}
          {t(pending ? 'networkSearch.verifying' : 'networkSearch.verify')}
        </Button>
      </form>
      <div aria-live="polite" className="min-w-0">
        {error && <p role="alert" className="network-search-error mt-3">{error}</p>}
        {result && <>
          <p className="mt-3 text-xs text-muted-foreground">{t('networkSearch.verificationResult', { count: result.results.length, ms: Math.round(result.elapsedMs) })}</p>
          {hasUnresponsive && <div className="network-search-warning mt-3"><span>{t('networkSearch.unresponsive')}</span><pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(result.unresponsiveEngines, null, 2)}</pre></div>}
          <ul className="mt-3 divide-y divide-border">
            {result.results.map((hit, index) => <li key={`${hit.url}:${index}`} className="space-y-1 py-3 first:pt-0">
              <p className="break-words text-sm font-medium">{hit.title}</p>
              <p className="break-all text-xs text-muted-foreground">{hit.url}</p>
              {hit.snippet && <p className="break-words text-sm text-muted-foreground">{hit.snippet}</p>}
            </li>)}
          </ul>
        </>}
      </div>
    </section>
  );
}
