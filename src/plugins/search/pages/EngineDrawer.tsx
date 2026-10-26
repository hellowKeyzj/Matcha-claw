import { useState } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { StableScrollArea } from '@/components/scroll';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import type { SearchEngine, SearchEngineConfig } from '@/types/network-search';
import { engineLabel } from './engine-names';

type Props = { engine?: SearchEngine; config: SearchEngineConfig; disabled: boolean; onUpdate: (config: SearchEngineConfig) => void };

export function EngineDrawer({ engine, config, disabled, onUpdate }: Props) {
  const { t } = useTranslation('settings');
  const displayName = engineLabel(t, config.name);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(config);

  return <Sheet open={open} onOpenChange={(value) => { setOpen(value); if (value) setDraft(config); }}>
    <SheetTrigger asChild><Button type="button" variant="ghost" size="sm" className="network-search-config" disabled={disabled} aria-label={t('networkSearch.configureEngine', { name: displayName })}>
      <span className="hidden sm:inline">{t('networkSearch.configure')}</span><ChevronRight aria-hidden className="h-4 w-4" />
    </Button></SheetTrigger>
    <SheetContent aria-describedby={undefined} showCloseButton={false} className="network-search-drawer flex w-full max-w-[440px] flex-col gap-5 overflow-hidden sm:max-w-[440px]">
      <SheetHeader className="shrink-0 space-y-3 text-left">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>{t('networkSearch.engineDetails')}</span><SheetClose asChild><Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label={t('networkSearch.closeDetails')}><X aria-hidden className="h-4 w-4" /></Button></SheetClose></div>
        <SheetTitle className="break-words text-xl tracking-tight">{displayName}</SheetTitle>
        <dl className="flex min-w-0 gap-2 text-xs text-muted-foreground"><dt className="shrink-0">{t('networkSearch.engineId')}</dt><dd className="min-w-0 break-words font-mono">{config.name}</dd></dl>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">{engine ? engine.categories.map((category) => <span key={category} className="rounded-md bg-muted px-2 py-1">{t(`networkSearch.categories.${category}`, { defaultValue: category })}</span>) : <span>{t('networkSearch.notLoaded')}</span>}</div>
      </SheetHeader>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); onUpdate(draft); setOpen(false); }}>
        <StableScrollArea className="min-h-0 flex-1">
          <div className="network-search-setting"><Label htmlFor="search-engine-enabled">{t('networkSearch.defaultEnabled')}</Label><Switch id="search-engine-enabled" checked={draft.enabled} onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} /></div>
          <div className="network-search-setting"><Label htmlFor="search-engine-timeout">{t('networkSearch.timeoutSeconds')}</Label><Input id="search-engine-timeout" type="number" min={1} max={120} step={1} placeholder={t('networkSearch.inherit')} value={draft.timeoutSeconds ?? ''} onChange={(event) => setDraft((current) => ({ ...current, timeoutSeconds: event.target.value === '' ? null : Number(event.target.value) }))} className="h-10 w-32 text-sm" /></div>
          <div className="network-search-setting"><Label htmlFor="search-engine-weight">{t('networkSearch.weight')}</Label><Input id="search-engine-weight" type="number" min={Number.MIN_VALUE} max={100} step="any" placeholder={t('networkSearch.inherit')} value={draft.weight ?? ''} onChange={(event) => setDraft((current) => ({ ...current, weight: event.target.value === '' ? null : Number(event.target.value) }))} className="h-10 w-32 text-sm" /></div>
          {engine && <dl className="mt-5 space-y-3 pb-1 text-xs text-muted-foreground">
            <div className="flex justify-between gap-3"><dt>{t('networkSearch.languageSupport')}</dt><dd>{t(engine.languageSupport ? 'networkSearch.supported' : 'networkSearch.unsupported')}</dd></div>
            <div className="flex justify-between gap-3"><dt>{t('networkSearch.safeSearch')}</dt><dd>{t(engine.safeSearch ? 'networkSearch.supported' : 'networkSearch.unsupported')}</dd></div>
            <div className="flex justify-between gap-3"><dt>{t('networkSearch.catalogTimeout')}</dt><dd>{t('networkSearch.seconds', { count: engine.timeoutSeconds })}</dd></div>
          </dl>}
        </StableScrollArea>
        <div className="mt-5 shrink-0 border-t border-border pt-4">
          <p className="mb-3 text-xs text-muted-foreground">{t('networkSearch.drawerDraft')}</p>
          <Button type="submit" className="w-full">{t('networkSearch.updateDraft')}</Button>
        </div>
      </form>
    </SheetContent>
  </Sheet>;
}
