import { startTransition } from 'react';
import { MessageSquare } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
      className="group flex items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-[13px] font-medium tracking-[-0.01em] text-[hsl(var(--shell-text-muted))] transition-[background-color,color] hover:bg-[hsl(var(--shell-surface-hover))] hover:text-[hsl(var(--shell-icon-active))] disabled:pointer-events-none disabled:opacity-45"
    >
      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[hsl(var(--shell-icon))] group-hover:text-[hsl(var(--shell-icon-active))]">
        <MessageSquare className="h-[17px] w-[17px]" />
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{t('sidebar.newChat')}</span>
    </button>
  );
}
