import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';

interface AssistantPendingIndicatorProps {
  mode: 'typing' | 'activity' | 'compacting';
}

function PendingDots() {
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-1">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="inline-block text-[16px] leading-none text-muted-foreground/72"
          style={{
            animation: 'chat-pending-dot 1.1s infinite ease-in-out',
            animationDelay: `${index * 160}ms`,
          }}
        >
          .
        </span>
      ))}
    </span>
  );
}

export const AssistantPendingIndicator = memo(function AssistantPendingIndicator({
  mode,
}: AssistantPendingIndicatorProps) {
  const { t } = useTranslation('chat');
  const label = mode === 'compacting'
    ? t('pending.compacting')
    : (mode === 'activity'
        ? t('pending.activity')
        : t('pending.typing'));

  return (
    <div
      data-chat-pending-mode={mode}
      className={cn(
        CHAT_LAYOUT_TOKENS.assistantSurface,
        'flex min-h-[34px] items-center px-0.5 py-1.5',
      )}
    >
      <div className="inline-flex items-center gap-2 rounded-full px-1 py-1 text-[13px] text-muted-foreground/90">
        <span className="leading-none">{label}</span>
        <PendingDots />
      </div>
    </div>
  );
});
