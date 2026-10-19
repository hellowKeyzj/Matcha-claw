import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, FileText, Loader2, Plus, RotateCw, Square, Wrench, X } from 'lucide-react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { useTranslation } from 'react-i18next';
import { StableScrollArea } from '@/components/scroll';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { fetchNetworkSearchLogs } from '@/lib/network-search';
import type { SearchConfig, SearchSnapshot } from '@/types/network-search';
import { SearchSelect } from './SearchSelect';
import { SEARCH_LANGUAGES } from './languages';

type Props = {
  snapshot: SearchSnapshot;
  draft: SearchConfig;
  disabled: boolean;
  pending: string | null;
  onChange: (patch: Partial<SearchConfig>) => void;
  onAction: (action: 'prepare' | 'restart' | 'stop') => void;
};

function ServiceLogs() {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  const close = () => { request.current?.abort(); request.current = null; setPending(false); setOpen(false); };
  const load = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setOpen(true);
    setPending(true);
    setError('');
    try {
      const result = await fetchNetworkSearchLogs(controller.signal);
      if (!controller.signal.aborted) setLines(result.lines);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return <>
    <Button type="button" size="sm" variant="outline" onClick={() => { if (open) close(); else void load(); }} aria-expanded={open}><FileText aria-hidden className="h-4 w-4" />{t('networkSearch.logs')}</Button>
    {open && <section className="w-full rounded-xl border border-border p-4" aria-label={t('networkSearch.logs')} aria-busy={pending}>
      <div className="mb-3 flex items-center justify-between gap-3"><h4 className="text-sm font-medium">{t('networkSearch.logs')}</h4><div className="flex gap-1"><Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => void load()}>{pending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <RotateCw aria-hidden className="h-4 w-4" />}{t('networkSearch.refresh')}</Button><Button type="button" variant="ghost" size="icon" className="h-9 w-9" onClick={close} aria-label={t('networkSearch.closeLogs')}><X aria-hidden className="h-4 w-4" /></Button></div></div>
      {error ? <p role="alert" className="network-search-error">{error}</p> : <StableScrollArea className="max-h-72 rounded-lg bg-muted/40 p-3"><pre className="whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">{pending ? t('networkSearch.loading') : lines?.length ? lines.join('\n') : t('networkSearch.noLogs')}</pre></StableScrollArea>}
    </section>}
  </>;
}

export function Advanced({ snapshot, draft, disabled, pending, onChange, onAction }: Props) {
  const { t, i18n } = useTranslation('settings');
  const categories = [...new Set([...snapshot.engines.flatMap((engine) => engine.categories), ...draft.categories])].sort();
  const categoryLabel = (value: string) => t(`networkSearch.categories.${value}`, { defaultValue: value });
  const addCategoryButton = useRef<HTMLButtonElement>(null);
  const languageOptions = useMemo(() => {
    const locale = i18n.resolvedLanguage ?? i18n.language;
    const names = new Intl.DisplayNames([locale], { type: 'language' });
    const languages = SEARCH_LANGUAGES.map((value) => ({ value, label: names.of(value) ?? value }))
      .sort((a, b) => a.label.localeCompare(b.label, locale));
    const options = [{ value: 'all', label: t('networkSearch.languageDefault') }, { value: 'auto', label: t('networkSearch.languageAuto') }, ...languages];
    if (!options.some((option) => option.value === draft.language)) options.push({ value: draft.language, label: draft.language });
    return options;
  }, [draft.language, i18n.language, i18n.resolvedLanguage, t]);
  return <StableScrollArea className="network-search-advanced min-h-0 min-w-0 flex-1">
    <div className="max-w-3xl">
      <fieldset disabled={disabled} className="min-w-0">
        <legend className="mb-1 text-base font-semibold tracking-tight">{t('networkSearch.searchDefaults')}</legend>
        <div className="network-search-setting"><Label htmlFor="search-language">{t('networkSearch.language')}</Label><SearchSelect id="search-language" label={t('networkSearch.language')} value={draft.language} options={languageOptions} onValueChange={(language) => onChange({ language })} disabled={disabled} className="w-full max-w-[240px]" /></div>
        <div className="network-search-setting network-search-category-field"><span id="search-default-categories" className="text-sm font-medium">{t('networkSearch.defaultCategories')}</span><div role="group" aria-labelledby="search-default-categories" className="network-search-category-selection">
          {draft.categories.length > 0 && <div className="network-search-selected-categories">
            {draft.categories.slice(0, 3).map((category) => <span key={category} className="network-search-category-tag">
              <span className="min-w-0 truncate">{categoryLabel(category)}</span><Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={t('networkSearch.removeCategory', { name: categoryLabel(category) })} onClick={() => { onChange({ categories: draft.categories.filter((value) => value !== category) }); addCategoryButton.current?.focus(); }} className="h-6 w-6 shrink-0"><X aria-hidden className="h-3 w-3" /></Button>
            </span>)}
            {draft.categories.length > 3 && <span className="self-center text-xs text-muted-foreground">{t('networkSearch.moreCategoriesSelected', { count: draft.categories.length - 3 })}</span>}
          </div>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button ref={addCategoryButton} type="button" variant="ghost" size="sm" disabled={disabled} className="h-8 self-start px-2"><Plus aria-hidden className="h-3.5 w-3.5" />{t('networkSearch.addCategory')}</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={4} aria-label={t('networkSearch.defaultCategories')} className="network-search-category-menu w-[280px] max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain">
              {categories.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">{t('networkSearch.catalogUnavailable')}</p>}
              {categories.map((category) => <DropdownMenuPrimitive.CheckboxItem key={category} checked={draft.categories.includes(category)} disabled={disabled} onSelect={(event) => event.preventDefault()} onCheckedChange={(checked) => onChange({ categories: checked ? [...draft.categories, category] : draft.categories.filter((value) => value !== category) })} className="flex cursor-default select-none items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-45">
                <span aria-hidden className="network-search-category-checkbox flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-[hsl(var(--shell-border-strong))]"><DropdownMenuPrimitive.ItemIndicator><Check className="h-3 w-3" /></DropdownMenuPrimitive.ItemIndicator></span><span className="min-w-0 break-words">{categoryLabel(category)}</span>
              </DropdownMenuPrimitive.CheckboxItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        </div></div>
        <div className="network-search-setting"><Label htmlFor="search-safe-search">{t('networkSearch.safeSearch')}</Label><SearchSelect id="search-safe-search" label={t('networkSearch.safeSearch')} value={String(draft.safeSearch)} options={[{ value: '0', label: t('networkSearch.safeSearchOff') }, { value: '1', label: t('networkSearch.safeSearchModerate') }, { value: '2', label: t('networkSearch.safeSearchStrict') }]} onValueChange={(value) => onChange({ safeSearch: Number(value) as SearchConfig['safeSearch'] })} disabled={disabled} className="h-10 w-full max-w-[240px] text-sm" /></div>
        <div className="network-search-setting"><Label htmlFor="search-result-count">{t('networkSearch.resultCount')}</Label><Input id="search-result-count" type="number" min={1} max={10} step={1} required value={Number.isFinite(draft.resultCount) ? draft.resultCount : ''} onChange={(event) => onChange({ resultCount: event.target.valueAsNumber })} className="h-10 w-28 text-sm" /></div>
        <div className="network-search-setting"><Label htmlFor="search-timeout">{t('networkSearch.timeoutSeconds')}</Label><Input id="search-timeout" type="number" min={1} max={120} step={1} required value={Number.isFinite(draft.requestTimeoutSeconds) ? draft.requestTimeoutSeconds : ''} onChange={(event) => onChange({ requestTimeoutSeconds: event.target.valueAsNumber })} className="h-10 w-28 text-sm" /></div>
      </fieldset>
      <fieldset disabled={disabled} className="mt-7 min-w-0">
        <legend className="mb-1 text-base font-semibold tracking-tight">{t('networkSearch.localService')}</legend>
        <div className="network-search-setting"><Label htmlFor="search-auto-start">{t('networkSearch.autoStart')}</Label><Switch id="search-auto-start" checked={draft.autoStart} onCheckedChange={(autoStart) => onChange({ autoStart })} /></div>
        <div className="network-search-setting"><Label htmlFor="search-proxy">{t('networkSearch.proxyUrl')}</Label><Input id="search-proxy" type="url" value={draft.proxyUrl ?? ''} onChange={(event) => onChange({ proxyUrl: event.target.value || null })} placeholder={t('networkSearch.directConnection')} autoComplete="off" spellCheck={false} className="h-10 w-full max-w-[340px] text-sm" /></div>
        {draft.proxyUrl && <p className="network-search-warning mt-3">{t('networkSearch.proxySafety')}</p>}
      </fieldset>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onAction('prepare')}>{pending === 'prepare' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Wrench aria-hidden className="h-4 w-4" />}{t('networkSearch.prepare')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onAction('restart')}>{pending === 'restart' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <RotateCw aria-hidden className="h-4 w-4" />}{t('networkSearch.restart')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled || snapshot.service.phase === 'stopped'} onClick={() => onAction('stop')}>{pending === 'stop' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Square aria-hidden className="h-3.5 w-3.5" />}{t('networkSearch.stop')}</Button>
        <ServiceLogs />
      </div>
    </div>
  </StableScrollArea>;
}
