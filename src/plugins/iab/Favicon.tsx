import { useState } from 'react';
import { Download, Globe, History } from 'lucide-react';
import { useIabStore } from './store';

export function Favicon({ ownerId, tabId, className, 'aria-hidden': ariaHidden }: {
  ownerId: string; tabId: string; className?: string; 'aria-hidden'?: boolean;
}) {
  const tab = useIabStore((state) => state.ownerId === ownerId ? state.tabs.find((entry) => entry.id === tabId) : undefined);
  const [failed, setFailed] = useState<string>();
  const url = tab?.faviconUrl;
  const Icon = tab?.internalPage === 'history' ? History : tab?.internalPage === 'downloads' ? Download : Globe;
  return !tab?.internalPage && url && failed !== url
    ? <img key={url} src={url} alt="" aria-hidden={ariaHidden} className={className} onError={() => setFailed(url)} />
    : <Icon aria-hidden={ariaHidden} className={className} />;
}
