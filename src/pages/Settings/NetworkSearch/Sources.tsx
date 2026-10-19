import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Search, SearchCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { SearchConfig, SearchEngine, SearchEngineConfig, SearchSnapshot } from '@/types/network-search';
import { EngineDrawer } from './EngineDrawer';
import { engineLabel } from './engine-names';
import { SearchSelect } from './SearchSelect';
import { Verification } from './Verification';

type Props = { snapshot: SearchSnapshot; draft: SearchConfig; disabled: boolean; onChange: (patch: Partial<SearchConfig>) => void };
const PAGE_SIZE = 25;
const PRIMARY_CATEGORIES = ['general', 'images', 'news', 'videos'];

export function Sources({ snapshot, draft, disabled, onChange }: Props) {
  const { t } = useTranslation('settings');
  const [category, setCategory] = useState('');
  const [name, setName] = useState('');
  const [newEngine, setNewEngine] = useState('');
  const [showAddEngine, setShowAddEngine] = useState(false);
  const [page, setPage] = useState(0);
  const [showVerification, setShowVerification] = useState(false);
  const addEngineButton = useRef<HTMLButtonElement>(null);
  const newEngineInput = useRef<HTMLInputElement>(null);
  const tableViewport = useRef<HTMLDivElement>(null);
  const categories = useMemo(() => [...new Set(snapshot.engines.flatMap((engine) => engine.categories))].sort(), [snapshot.engines]);
  const primaryCategories = PRIMARY_CATEGORIES.filter((value) => categories.includes(value));
  const moreCategories = categories.filter((value) => !PRIMARY_CATEGORIES.includes(value));
  const configs = useMemo(() => new Map(draft.engines.map((engine) => [engine.name, engine])), [draft.engines]);
  const engineConfig = (engine: SearchEngine): SearchEngineConfig => configs.get(engine.name) ?? {
    name: engine.name, enabled: engine.enabled, timeoutSeconds: null, weight: null,
  };
  const updateEngine = (config: SearchEngineConfig) => {
    onChange({ engines: configs.has(config.name)
      ? draft.engines.map((entry) => entry.name === config.name ? config : entry)
      : [...draft.engines, config] });
  };
  const catalog = new Map(snapshot.engines.map((engine) => [engine.name, engine]));
  const entries = [...snapshot.engines.map((engine) => engineConfig(engine)), ...draft.engines.filter((engine) => !catalog.has(engine.name))];
  const query = name.trim().toLocaleLowerCase();
  const filtered = entries.filter((config) => (!category || catalog.get(config.name)?.categories.includes(category))
    && (config.name.toLocaleLowerCase().includes(query) || engineLabel(t, config.name).toLocaleLowerCase().includes(query)));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const enabledCount = entries.filter((engine) => engine.enabled).length;
  useEffect(() => { if (showAddEngine) newEngineInput.current?.focus(); }, [showAddEngine]);
  useEffect(() => { if (tableViewport.current) tableViewport.current.scrollTop = 0; }, [currentPage, category, name]);
  const closeAddEngine = () => {
    setShowAddEngine(false);
    setNewEngine('');
    addEngineButton.current?.focus();
  };
  const addEngine = () => {
    const exactName = newEngine.trim();
    if (!exactName || disabled) return;
    const existing = entries.find((engine) => engine.name === exactName);
    updateEngine(existing ? { ...existing, enabled: true } : { name: exactName, enabled: true, timeoutSeconds: null, weight: null });
    setCategory('');
    setName(exactName);
    setPage(0);
    closeAddEngine();
  };
  const categoryLabel = (value: string) => t(`networkSearch.categories.${value}`, { defaultValue: value });

  return <div className="network-search-sources">
    <div className="network-search-source-heading">
      <h3 className="text-lg font-semibold tracking-tight">{t('networkSearch.defaultSources')}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <Button ref={addEngineButton} type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => showAddEngine ? closeAddEngine() : setShowAddEngine(true)} aria-expanded={showAddEngine} aria-controls="network-search-add-engine">
          {!showAddEngine && <Plus aria-hidden className="h-4 w-4" />}{t(showAddEngine ? 'networkSearch.cancelAdd' : 'networkSearch.addEngine')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setShowVerification((value) => !value)} aria-expanded={showVerification}>
          <SearchCheck aria-hidden className="h-4 w-4" />{t('networkSearch.verifyService')}
        </Button>
      </div>
    </div>
    {showVerification && <Verification title={t('networkSearch.verifyAppliedService')} target={{}} revision={snapshot.appliedRevision} disabled={disabled || snapshot.service.phase !== 'running'} onClose={() => setShowVerification(false)} />}
    <div className="network-search-toolbar">
      <div role="group" aria-label={t('networkSearch.category')} className="network-search-categories">
        <Button type="button" size="sm" variant="ghost" aria-pressed={category === ''} data-active={category === ''} onClick={() => { setCategory(''); setPage(0); }}>{t('networkSearch.allCategories')}</Button>
        {primaryCategories.map((value) => <Button key={value} type="button" size="sm" variant="ghost" aria-pressed={category === value} data-active={category === value} onClick={() => { setCategory(value); setPage(0); }}>{categoryLabel(value)}</Button>)}
        {moreCategories.length > 0 && <SearchSelect label={t('networkSearch.moreCategories')} placeholder={t('networkSearch.moreCategories')} value={moreCategories.includes(category) ? category : ''} options={moreCategories.map((value) => ({ value, label: categoryLabel(value) }))} onValueChange={(value) => { setCategory(value); setPage(0); }} className={`network-search-more-categories${moreCategories.includes(category) ? ' is-active' : ''}`} />}
      </div>
      <div className="network-search-find">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input type="search" value={name} onChange={(event) => { setName(event.target.value); setPage(0); }} aria-label={t('networkSearch.findEngine')} placeholder={t('networkSearch.findEngine')} className="h-10 pl-9 text-sm" />
      </div>
    </div>
    {showAddEngine && <form id="network-search-add-engine" className="network-search-add-engine" onSubmit={(event) => { event.preventDefault(); addEngine(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeAddEngine(); } }}>
      <Input ref={newEngineInput} value={newEngine} onChange={(event) => setNewEngine(event.target.value)} aria-label={t('networkSearch.exactEngineName')} placeholder={t('networkSearch.exactEngineName')} required maxLength={256} pattern={'[^,\\x00-\\x1f\\x7f]+'} disabled={disabled} autoComplete="off" spellCheck={false} className="h-10 min-w-0 flex-[0_1_270px] text-sm max-sm:flex-[1_1_180px]" />
      <Button type="submit" size="sm" variant="outline" disabled={disabled || !newEngine.trim()} className="h-10"><Plus aria-hidden className="h-4 w-4" />{t('networkSearch.addEngine')}</Button>
    </form>}
    {snapshot.engines.length === 0 && <div className="network-search-empty">{t('networkSearch.catalogUnavailable')}</div>}
    {entries.length === 0 ? null
      : <div ref={tableViewport} className="network-search-table-wrap">
        <table className="network-search-table" aria-label={t('networkSearch.sources')}>
          <thead><tr><th scope="col">{t('networkSearch.source')}</th><th scope="col" className="network-search-category-cell">{t('networkSearch.category')}</th><th scope="col" className="text-right">{t('networkSearch.defaultEnabled')}</th><th scope="col"><span className="sr-only">{t('networkSearch.configure')}</span></th></tr></thead>
          <tbody>
            {visible.map((config) => {
              const engine = catalog.get(config.name);
              const displayName = engineLabel(t, config.name);
              const categoryText = engine ? engine.categories.map(categoryLabel).join(' · ') : t('networkSearch.notLoaded');
              return <tr key={config.name}>
                <th scope="row"><span className="break-words text-sm font-medium">{displayName}</span><span className="mt-1 block text-xs font-normal text-muted-foreground sm:hidden">{categoryText}</span></th>
                <td className="network-search-category-cell text-muted-foreground"><span className="break-words">{categoryText}</span></td>
                <td className="text-right"><Switch checked={config.enabled} disabled={disabled} aria-label={t('networkSearch.enableEngine', { name: displayName })} onCheckedChange={(enabled) => updateEngine({ ...config, enabled })} /></td>
                <td><EngineDrawer engine={engine} config={config} disabled={disabled} onUpdate={updateEngine} /></td>
              </tr>;
            })}
            {visible.length === 0 && <tr><td colSpan={4} className="!py-10 text-center text-muted-foreground">{t('networkSearch.noMatchingEngines')}</td></tr>}
          </tbody>
        </table>
      </div>}
    <div className="network-search-pagination text-xs text-muted-foreground">
      <span>{t('networkSearch.catalogCount', { count: entries.length, enabled: enabledCount, filtered: filtered.length })}</span>
      {pageCount > 1 && <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label={t('networkSearch.previousPage')}><ChevronLeft aria-hidden className="h-4 w-4" /></Button>
        <span>{currentPage + 1} / {pageCount}</span>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)} aria-label={t('networkSearch.nextPage')}><ChevronRight aria-hidden className="h-4 w-4" /></Button>
      </div>}
    </div>
  </div>;
}
