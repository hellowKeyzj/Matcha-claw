import { useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkspacePageProps } from '@/plugins/workspace/extensions';
import type { IabEvent } from '@/types/desktop/iab';
import { BrowserChrome } from './BrowserChrome';
import { HistoryPage } from './HistoryPage';
import { DownloadsPage } from './DownloadsPage';
import { IabConfirmation } from './IabConfirmation';
import { useNativeView } from './useNativeView';
import { iabCommand, onIabEvent, reportIabError, useIabStore } from './store';
import './iab.css';

type ClearRequest = Extract<IabEvent, { type: 'clear-data-requested' }>;

export function IabToolLayer({ sessionIdentity, visible: pageVisible, ownerId, tabId }: WorkspacePageProps & { ownerId: string; tabId: string }) {
  const { t, i18n } = useTranslation('iab');
  const currentOwnerId = useIabStore((state) => state.ownerId);
  const activeTabId = useIabStore((state) => state.activeTabId);
  const tab = useIabStore((state) => state.tabs.find((entry) => entry.ownerId === ownerId && entry.id === tabId) ?? null);
  const matchingOwner = currentOwnerId === ownerId;
  const visible = pageVisible && matchingOwner && activeTabId === tabId;
  const surface = useRef<HTMLDivElement>(null);
  const placeholder = useRef<HTMLDivElement>(null);
  const [clearRequest, setClearRequest] = useState<ClearRequest | null>(null);
  const [clearError, setClearError] = useState(false);
  const clearRunning = useRef(false);
  const browserVisible = visible && clearRequest === null;
  useNativeView(placeholder, browserVisible && !!tab && !tab.internalPage && tab.url !== 'about:blank' && !tab.crash, matchingOwner ? ownerId : null);
  useEffect(() => {
    if (!visible) { setClearRequest(null); setClearError(false); }
  }, [visible, ownerId]);
  useEffect(() => onIabEvent((event) => {
    if (visible && event.type === 'clear-data-requested' && event.ownerId === ownerId && event.tabId === tabId) {
      setClearRequest(event); setClearError(false);
    }
  }), [visible, ownerId, tabId]);
  useEffect(() => {
    if (!matchingOwner) return;
    const sync = () => void iabCommand({ action: 'set-presentation', theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', locale: i18n.language }).catch(() => {});
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [i18n.language, matchingOwner, ownerId]);
  const clearData = async () => {
    const target = clearRequest;
    if (!target || clearRunning.current || target.ownerId !== useIabStore.getState().ownerId) return;
    clearRunning.current = true;
    try {
      await iabCommand({ action: 'clear-data', tabId: target.tabId, token: target.token, data: target.data, confirmation: { scope: 'shared-session', confirmed: true } });
      if (target.ownerId === useIabStore.getState().ownerId) {
        setClearRequest((current) => current === target ? null : current); setClearError(false);
      }
    } catch { if (target.ownerId === useIabStore.getState().ownerId) setClearError(true); }
    finally { clearRunning.current = false; }
  };
  return <div ref={surface} data-browser-surface className="iab-root flex h-full min-h-0 min-w-0 flex-col bg-card text-foreground">
    <BrowserChrome key={`${ownerId}:${tabId}:${browserVisible}`} tab={tab} sessionIdentity={sessionIdentity} surface={surface} visible={browserVisible} />
    <div ref={placeholder} className="min-h-0 flex-1">
      {tab?.internalPage === 'history' ? <HistoryPage key={tab.id} tabId={tab.id} visible={browserVisible} />
        : tab?.internalPage === 'downloads' ? <DownloadsPage key={tab.id} visible={browserVisible} />
        : tab?.crash ? <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted-foreground"><p>{t('crashed')}</p><button type="button" className="iab-action" onClick={() => void iabCommand({ action: 'reload', tabId: tab.id }).catch(reportIabError)}>{t('reload')}</button></div>
        : !tab || tab.url === 'about:blank' ? <div className="flex h-full min-h-40 flex-col items-center justify-center gap-4 px-6 pb-12 text-center text-muted-foreground"><Globe aria-hidden="true" className="h-7 w-7 stroke-[1.3] text-muted-foreground/50" /><p className="text-[13px]">{t('newTabHint')}</p></div> : null}
    </div>
    <IabConfirmation open={clearRequest !== null} title={t(clearRequest?.data === 'cache' ? 'clearCache' : 'clearSiteData')} message={t(clearRequest?.data === 'cache' ? 'sharedCacheDescription' : 'sharedSiteDataDescription')}
      confirmLabel={t('clear')} onConfirm={clearData} onCancel={() => { if (!clearRunning.current) setClearRequest(null); }} error={clearError} />
  </div>;
}
