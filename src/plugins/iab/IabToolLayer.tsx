import { useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWorkspace } from '@/plugins/workspace/context';
import type { WorkspacePageProps } from '@/plugins/workspace/extensions';
import type { IabEvent } from '@/types/desktop/iab';
import { BrowserChrome } from './BrowserChrome';
import { HistoryPage } from './HistoryPage';
import { DownloadsPage } from './DownloadsPage';
import { IabConfirmation } from './IabConfirmation';
import { iabPageId } from './browser-page';
import { buildIabDisplayScope, iabCommand, isIabTabVisible, onIabEvent, reportIabError, useIabStore } from './store';
import './iab.css';

type ClearRequest = Extract<IabEvent, { type: 'clear-data-requested' }>;

export function IabToolLayer({ visible: pageVisible, ownerId, tabId }: WorkspacePageProps & { ownerId: string; tabId: string }) {
  const { t } = useTranslation('iab');
  const workspace = useWorkspace();
  const currentOwnerId = useIabStore((state) => state.ownerId);
  const displayScope = buildIabDisplayScope(workspace);
  const tab = useIabStore((state) => state.tabs.find((entry) => entry.ownerId === ownerId && entry.id === tabId && isIabTabVisible(entry, displayScope)) ?? null);
  const matchingOwner = currentOwnerId === ownerId;
  const visible = pageVisible && matchingOwner && !!tab;
  const surface = useRef<HTMLDivElement>(null);
  const [clearRequest, setClearRequest] = useState<ClearRequest | null>(null);
  const [clearError, setClearError] = useState(false);
  const clearRunning = useRef(false);
  const browserVisible = visible && clearRequest === null;
  useEffect(() => {
    if (!visible) { setClearRequest(null); setClearError(false); }
  }, [visible, ownerId]);
  useEffect(() => onIabEvent((event) => {
    if (visible && event.type === 'clear-data-requested' && event.ownerId === ownerId && event.tabId === tabId) {
      setClearRequest(event); setClearError(false);
    }
  }), [visible, ownerId, tabId]);
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
  const activate = () => {
    const pageId = iabPageId(ownerId, tabId);
    if (visible && workspace.activePageId !== pageId) workspace.activatePage(pageId, { reveal: false });
  };
  return <div ref={surface} data-browser-surface onPointerDownCapture={activate} onFocusCapture={activate} className="iab-root flex h-full min-h-0 min-w-0 flex-col bg-card text-foreground">
    <BrowserChrome key={`${ownerId}:${tabId}:${browserVisible}`} tab={tab} surface={surface} visible={browserVisible} />
    <div data-iab-owner={ownerId} data-iab-tab={tabId} data-iab-visible={browserVisible && !tab?.crash} className="min-h-0 flex-1">
      {tab?.internalPage === 'history' ? <HistoryPage key={tab.id} tabId={tab.id} visible={browserVisible} />
        : tab?.internalPage === 'downloads' ? <DownloadsPage key={tab.id} visible={browserVisible} />
        : tab?.crash ? <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted-foreground"><p>{t('crashed')}</p><button type="button" className="iab-action" onClick={() => void iabCommand({ action: 'reload', tabId: tab.id }).catch(reportIabError)}>{t('reload')}</button></div>
        : !tab || tab.url === 'about:blank' ? <div className="flex h-full min-h-40 flex-col items-center justify-center gap-4 px-6 pb-12 text-center text-muted-foreground"><Globe aria-hidden="true" className="h-7 w-7 stroke-[1.3] text-muted-foreground/50" /><p className="text-[13px]">{t('newTabHint')}</p></div> : null}
    </div>
    <IabConfirmation open={clearRequest !== null} title={t(clearRequest?.data === 'cache' ? 'clearCache' : 'clearSiteData')} message={t(clearRequest?.data === 'cache' ? 'sharedCacheDescription' : 'sharedSiteDataDescription')}
      confirmLabel={t('clear')} onConfirm={clearData} onCancel={() => { if (!clearRunning.current) setClearRequest(null); }} error={clearError} />
  </div>;
}
