import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Download, MoreHorizontal, RotateCw, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { buildSessionIdentityKey, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { IabBounds, IabFindResult, IabHistoryEntry, IabTab, IabToolAnchor } from '@/types/desktop/iab';
import { iabCommand, IabProjectionDiscarded, normalizeIabAddress, onIabEvent, reportIabError, useIabStore } from './store';

// Keep CSS rects unscaled; Main converts once using the primary renderer's zoom factor.
function readIabBounds(element: HTMLElement): IabBounds {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function readIabToolAnchor(element: HTMLElement, keyboard: boolean): IabToolAnchor {
  const surface = element.closest<HTMLElement>('[data-browser-surface]');
  return { ...readIabBounds(element), keyboard, ...(surface ? { browserBounds: readIabBounds(surface) } : {}) };
}

function useAddress(tab: IabTab | null, input: RefObject<HTMLInputElement | null>, visible: boolean) {
  const initial = tab && !tab.internalPage && tab.url !== 'about:blank' ? tab.url : '';
  const [draft, setDraft] = useState(initial);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [entries, setEntries] = useState<IabHistoryEntry[]>([]);
  const [selected, setSelected] = useState(-1);
  const [historyRevision, setHistoryRevision] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = useId();
  const tabId = tab?.id;
  const ownerId = useIabStore((state) => state.ownerId);
  const canSuggest = tab?.url === 'about:blank' && !tab.internalPage;
  const hide = useCallback(() => {
    setDismissed(true); setEntries([]); setSelected(-1);
    if (ownerId === useIabStore.getState().ownerId) void iabCommand({ action: 'hide-suggestions' }).catch(() => {});
  }, [ownerId]);
  useEffect(() => () => { if (blurTimer.current) clearTimeout(blurTimer.current); hide(); }, [hide]);
  useEffect(() => { if (!canSuggest || !visible) void iabCommand({ action: 'hide-suggestions' }).catch(() => {}); }, [canSuggest, visible]);
  const navigate = useCallback((text: string) => {
    if (!tab || !text.trim()) return;
    hide(); setFocused(false); setDraft(text); input.current?.blur();
    void iabCommand({ action: 'navigate', tabId: tab.id, url: normalizeIabAddress(text) }).catch(reportIabError);
  }, [tab, hide, input]);
  useEffect(() => onIabEvent((event) => {
    if (event.type === 'suggestion-selected' && event.tabId === tab?.id && canSuggest) navigate(event.entry.url);
    if (event.type === 'suggestion-remove-started' && event.tabId === tab?.id && canSuggest) {
      if (blurTimer.current) clearTimeout(blurTimer.current);
      setFocused(true); setDismissed(false); input.current?.focus();
    }
    if (event.type === 'history-changed') { setSelected(-1); setHistoryRevision((value) => value + 1); }
  }), [tab?.id, canSuggest, navigate, input]);
  useEffect(() => {
    if (!visible || !ownerId || !tabId || !canSuggest || !focused || dismissed || composing || !input.current) return;
    let current = true;
    void iabCommand({ action: 'history-suggest', tabId, query: draft === initial ? '' : draft,
      selectedIndex: selected, anchor: readIabBounds(input.current) }).then((result) => {
      if (current && result.resultType === 'suggestions') setEntries(result.entries.slice(0, 8));
    }).catch((error) => { if (current && !(error instanceof IabProjectionDiscarded)) { setEntries([]); reportIabError(error); } });
    const pointerDown = (event: PointerEvent) => { if (event.target !== input.current) { hide(); input.current?.blur(); } };
    window.addEventListener('resize', hide);
    window.addEventListener('pointerdown', pointerDown, true);
    return () => { current = false; window.removeEventListener('resize', hide); window.removeEventListener('pointerdown', pointerDown, true); };
  }, [tabId, ownerId, visible, canSuggest, focused, dismissed, composing, draft, initial, selected, historyRevision, hide, input]);
  const expanded = !!canSuggest && focused && !dismissed && entries.length > 0;
  return { entries, selected, expanded, listId, canSuggest, hide,
    inputProps: {
      value: focused ? draft : initial,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setDraft(event.target.value); setSelected(-1); setDismissed(!canSuggest); },
      onFocus: () => { if (blurTimer.current) clearTimeout(blurTimer.current); if (!focused) setDraft(initial); setFocused(true); setDismissed(!canSuggest); input.current?.select(); },
      onClick: () => setDismissed(!canSuggest),
      onBlur: () => { blurTimer.current = setTimeout(() => { setFocused(false); hide(); }, 180); },
      onCompositionStart: () => { setComposing(true); hide(); },
      onCompositionEnd: () => { setComposing(false); setDismissed(!canSuggest); },
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.nativeEvent.isComposing || composing) return;
        if (canSuggest && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault(); setDismissed(false);
          setSelected((index) => entries.length ? index < 0 ? event.key === 'ArrowDown' ? 0 : entries.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length : -1);
        }
        if (event.key === 'Enter') { event.preventDefault(); navigate(canSuggest ? entries[selected]?.url ?? draft : draft); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); setDraft(initial); }
        if (event.key === 'Tab') hide();
      },
    },
  };
}

function AgentAccessButton({ tab, sessionIdentity, visible, onHideSuggestions }: { tab: IabTab | null; sessionIdentity?: SessionIdentity; visible: boolean; onHideSuggestions: () => void }) {
  const { t } = useTranslation('iab');
  const [accessPending, setAccessPending] = useState(false);
  const accessRunning = useRef(false);
  const accessHintId = useId();
  const sessionKey = sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : null;
  const agentAllowed = !!sessionKey && !!tab?.agentSessionIds.includes(sessionKey);
  const accessLabel = t(agentAllowed ? 'revokeAgentAccess' : 'allowAgentAccess');
  const accessHint = !sessionIdentity ? t('agentAccessRequiresSession') : accessPending ? t('agentAccessUpdating') : accessLabel;
  const setAgentAccess = async () => {
    const identity = sessionIdentity;
    const target = tab;
    if (!identity || !target || !visible || accessRunning.current) return;
    const current = useIabStore.getState();
    const currentTab = current.tabs.find((entry) => entry.ownerId === target.ownerId && entry.id === target.id);
    if (current.ownerId !== target.ownerId || current.activeTabId !== target.id || !currentTab) return;
    const allowed = !currentTab.agentSessionIds.includes(buildSessionIdentityKey(identity));
    accessRunning.current = true; setAccessPending(true);
    try { await iabCommand({ action: 'set-agent-access', tabId: target.id, identity, allowed }); }
    catch (error) { reportIabError(error); }
    finally { accessRunning.current = false; setAccessPending(false); }
  };
  return <>
    <span title={accessHint} className="inline-flex min-w-0 max-w-[42%] shrink">
      <Button type="button" variant="ghost" size="sm" className="h-8 rounded-lg px-2 text-xs font-normal" disabled={!tab || !sessionIdentity || accessPending || !visible}
        aria-label={accessLabel} aria-describedby={accessHintId} aria-busy={accessPending || undefined} title={accessHint} onClick={() => { onHideSuggestions(); void setAgentAccess(); }}>{accessLabel}</Button>
    </span>
    <span id={accessHintId} className="sr-only">{accessHint}</span>
  </>;
}

export function BrowserChrome({ tab, sessionIdentity, surface, visible }: { tab: IabTab | null; sessionIdentity?: SessionIdentity; surface: RefObject<HTMLDivElement | null>; visible: boolean }) {
  const { t } = useTranslation('iab');
  const addressInput = useRef<HTMLInputElement>(null);
  const address = useAddress(tab, addressInput, visible);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const composing = useRef(false);
  const [findResponse, setFindResponse] = useState<{ query: string; result: IabFindResult } | null>(null);
  const [findError, setFindError] = useState(false);
  const result = findOpen && findResponse?.query === query ? findResponse.result : null;
  const [previousUrl, setPreviousUrl] = useState(tab?.url);
  if (previousUrl !== tab?.url) {
    setPreviousUrl(tab?.url); setFindOpen(false); setQuery(''); setFindResponse(null); setFindError(false);
  }
  const tabId = tab?.id;
  const findInput = useRef<HTMLInputElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const search = useRef({ searchId: 0, text: '', requestId: null as number | null, pending: null as IabFindResult | null });
  const [menuOpen, setMenuOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const closeFind = useCallback(() => {
    setFindOpen(false); setQuery(''); setFindResponse(null);
    search.current = { searchId: search.current.searchId + 1, text: '', requestId: null, pending: null };
    if (tab) void iabCommand({ action: 'stop-find', tabId: tab.id }).catch(reportIabError);
    more.current?.focus();
  }, [tab]);
  const runFind = useCallback((text: string, forward = true) => {
    if (!visible || !tabId || composing.current) return;
    const searchId = ++search.current.searchId;
    search.current.text = text; search.current.requestId = null; search.current.pending = null;
    setFindResponse(null); setFindError(false);
    void iabCommand(text ? { action: 'find', tabId, text, searchId, forward } : { action: 'stop-find', tabId }).then((response) => {
      if (search.current.searchId !== searchId || response.resultType !== 'find') return;
      search.current.requestId = response.requestId;
      const pending = search.current.pending;
      search.current.pending = null;
      if (pending?.requestId === response.requestId) setFindResponse({ query: text, result: pending });
    }).catch((error) => {
      if (search.current.searchId !== searchId) return;
      search.current = { searchId: searchId + 1, text: '', requestId: null, pending: null };
      if (!(error instanceof IabProjectionDiscarded)) setFindError(true);
    });
  }, [tabId, visible]);
  const showFind = useCallback(() => {
    if (tab?.internalPage) {
      surface.current?.querySelector<HTMLInputElement>('[data-iab-internal-search]')?.focus();
      return;
    }
    if (!findOpen) runFind(query);
    setFindOpen(true);
    requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
  }, [tab?.internalPage, surface, findOpen, runFind, query]);
  useEffect(() => () => {
    search.current = { searchId: search.current.searchId + 1, text: '', requestId: null, pending: null };
    if (tabId) void iabCommand({ action: 'stop-find', tabId }).catch(() => {});
  }, [tabId, tab?.url]);
  useEffect(() => onIabEvent((event) => {
    if (visible && event.type === 'find-requested' && event.tabId === tab?.id) showFind();
    if (event.type === 'find-result' && event.result.ownerId === useIabStore.getState().ownerId && event.result.tabId === tab?.id && event.result.searchId === search.current.searchId) {
      if (search.current.requestId === null) search.current.pending = event.result;
      else if (event.result.requestId === search.current.requestId) setFindResponse({ query: search.current.text, result: event.result });
    }
    if (event.type === 'overlay-state') {
      setMenuOpen(event.state?.kind === 'menu' && event.state.tabId === tab?.id);
      setDownloadsOpen(event.state?.kind === 'downloads' && event.state.tabId === tab?.id);
    }
  }), [tab?.id, showFind, visible]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!visible || event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey) || !(event.target instanceof HTMLElement) || !surface.current?.contains(event.target)) return;
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); showFind(); }
      if (event.key.toLowerCase() === 'a' && !event.altKey && !event.shiftKey && (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); event.target.select(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [showFind, surface, visible]);
  const navigateAction = (action: 'back' | 'forward' | 'reload') => { if (tab) void iabCommand({ action, tabId: tab.id }).catch(reportIabError); };
  return <div data-browser-chrome className="shrink-0 bg-card text-foreground">
    <div className="flex h-11 items-center gap-1 border-b border-border/40 px-2.5">
      <button type="button" className="iab-icon" disabled={!tab?.canGoBack} aria-label={t('back')} title={t('back')} onClick={() => navigateAction('back')}><ArrowLeft aria-hidden="true" className="h-4 w-4" /></button>
      <button type="button" className="iab-icon" disabled={!tab?.canGoForward} aria-label={t('forward')} title={t('forward')} onClick={() => navigateAction('forward')}><ArrowRight aria-hidden="true" className="h-4 w-4" /></button>
      <input ref={addressInput} {...address.inputProps} type="text" maxLength={8192} autoComplete="off" spellCheck={false} disabled={!tab} aria-label={t('address')} placeholder={t('address')}
        role={address.canSuggest ? 'combobox' : undefined} aria-autocomplete={address.canSuggest ? 'list' : undefined} aria-expanded={address.canSuggest ? address.expanded : undefined}
        aria-controls={address.expanded ? address.listId : undefined} aria-activedescendant={address.expanded && address.selected >= 0 ? `${address.listId}-${address.selected}` : undefined}
        className="iab-field h-8 flex-1 rounded-lg border border-border/50 bg-secondary/70 px-3 text-foreground transition-colors focus:bg-card focus-visible:ring-1 focus-visible:ring-ring" />
      {address.expanded && <ul id={address.listId} role="listbox" aria-label={t('history')} className="sr-only">{address.entries.map((entry, index) => <li key={entry.id} id={`${address.listId}-${index}`} role="option" aria-selected={index === address.selected}>{entry.title} {entry.url}</li>)}</ul>}
      <button type="button" className="iab-icon" disabled={!tab} aria-label={t('reload')} title={t('reload')} aria-busy={tab?.loading || undefined} onClick={() => navigateAction('reload')}><RotateCw aria-hidden="true" className={`h-4 w-4 ${tab?.loading ? 'motion-safe:animate-spin' : ''}`} /></button>
      <AgentAccessButton key={sessionIdentity ? buildSessionIdentityKey(sessionIdentity) : null} tab={tab} sessionIdentity={sessionIdentity} visible={visible} onHideSuggestions={address.hide} />
      <button type="button" className="iab-icon" disabled={!tab} aria-label={t('downloads')} title={t('downloads')} aria-haspopup="dialog" aria-expanded={downloadsOpen} onClick={(event) => { address.hide(); if (tab) void iabCommand({ action: 'show-downloads', tabId: tab.id, anchor: readIabToolAnchor(event.currentTarget, event.detail === 0) }).catch(reportIabError); }}><Download aria-hidden="true" className="h-4 w-4" /></button>
      <button ref={more} type="button" className="iab-icon aria-expanded:bg-secondary" disabled={!tab} aria-label={t('more')} title={t('more')} aria-haspopup="dialog" aria-expanded={menuOpen}
        onClick={(event) => { address.hide(); if (tab) void iabCommand({ action: 'show-menu', tabId: tab.id, anchor: readIabToolAnchor(event.currentTarget, event.detail === 0) }).catch(reportIabError); }}><MoreHorizontal aria-hidden="true" className="h-4 w-4" /></button>
    </div>
    {findOpen && <div role="search" aria-label={t('find')} className="flex h-11 items-center gap-1 border-b border-border px-2">
      <Search aria-hidden="true" className="mx-1 h-4 w-4 shrink-0 text-muted-foreground" />
      <input ref={findInput} value={query} maxLength={1000} aria-label={t('find')} placeholder={t('find')} onChange={(event) => { setQuery(event.target.value); runFind(event.target.value); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={(event) => { composing.current = false; runFind(event.currentTarget.value); }}
        onKeyDown={(event) => { if (event.nativeEvent.isComposing || composing.current) return; if (event.key === 'Enter') { event.preventDefault(); runFind(query, !event.shiftKey); } if (event.key === 'Escape') { event.preventDefault(); closeFind(); } }}
        className="iab-field h-8 flex-1 rounded-md border border-border/50 bg-secondary/70 px-2.5 focus-visible:ring-1 focus-visible:ring-ring" />
      {query && <button type="button" className="iab-icon" aria-label={t('clearSearch')} onClick={() => { setQuery(''); runFind(''); findInput.current?.focus(); }}><X aria-hidden="true" className="h-3 w-3" /></button>}
      <span role="status" aria-live="polite" className="min-w-10 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{query && !findError ? result ? `${result.activeMatchOrdinal}/${result.matches}` : '…' : ''}</span>
      <button type="button" className="iab-icon" disabled={!query || !result?.matches} aria-label={t('previous')} title={t('previous')} onClick={() => runFind(query, false)}><ChevronUp aria-hidden="true" className="h-4 w-4" /></button>
      <button type="button" className="iab-icon" disabled={!query || !result?.matches} aria-label={t('next')} title={t('next')} onClick={() => runFind(query, true)}><ChevronDown aria-hidden="true" className="h-4 w-4" /></button>
      <button type="button" className="iab-icon" aria-label={t('closeFind')} title={t('closeFind')} onClick={closeFind}><X aria-hidden="true" className="h-4 w-4" /></button>
    </div>}
    {findError && <p role="alert" className="border-b border-border px-3 py-2 text-xs text-destructive">{t('failed')}</p>}
  </div>;
}
