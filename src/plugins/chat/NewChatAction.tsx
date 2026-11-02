import { startTransition } from 'react';
import { MessageSquare } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/plugins/chat/store';
import { selectSidebarNewSessionAction } from '@/plugins/chat/store/selectors';
import { getSessionItemCount } from '@/plugins/chat/store/store-state-helpers';
import { useLocalLicenseLocked } from '@/plugins/account/stores/license';

export default function NewChatAction() {
  const newSession = useChatStore(selectSidebarNewSessionAction);
  const licenseLocked = useLocalLicenseLocked();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useTranslation();

  return (
    <button
      type="button"
      disabled={licenseLocked}
      title={t('sidebar.newChat')}
      aria-label={t('sidebar.newChat')}
      aria-current={pathname === '/' ? 'page' : undefined}
      onClick={() => {
        const { currentSessionKey, loadedSessions } = useChatStore.getState();
        const hasItems = getSessionItemCount(loadedSessions[currentSessionKey]) > 0;
        if (pathname === '/' && hasItems) {
          void newSession();
        }
        startTransition(() => {
          navigate('/');
        });
      }}
      className={cn(
        'mx-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] transition-[background-color,color] hover:bg-[hsl(var(--shell-surface-hover))] hover:text-[hsl(var(--shell-icon-active))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--shell-surface))] disabled:pointer-events-none disabled:opacity-45',
        pathname === '/'
          ? 'bg-[hsl(var(--shell-surface-active))] text-[hsl(var(--shell-icon-active))]'
          : 'text-[hsl(var(--shell-icon))]',
      )}
    >
      <MessageSquare aria-hidden="true" className="h-[18px] w-[18px]" />
    </button>
  );
}
