import { useTranslation } from 'react-i18next';
import type { SessionRenderContentNotice } from '@/types/session/tool-card';

export function ContentNotices({ notices }: { notices?: ReadonlyArray<SessionRenderContentNotice> }) {
  const { t } = useTranslation('chat');
  if (!notices?.length) return null;
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      {[...new Set(notices)].map((notice) => (
        <p key={notice}>{t(notice === 'media-unavailable' ? 'media.unavailable' : 'media.contentOmitted')}</p>
      ))}
    </div>
  );
}
