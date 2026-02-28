import { Button } from '@/components/ui/button';
import type { SubagentSummary } from '@/types/subagent';
import { useTranslation } from 'react-i18next';

interface SubagentCardProps {
  agent: SubagentSummary;
  locked?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onManage: () => void;
  onChat: () => void;
}

export function SubagentCard({
  agent,
  locked = false,
  onEdit,
  onDelete,
  onManage,
  onChat,
}: SubagentCardProps) {
  const { t } = useTranslation('subagents');
  const displayEmoji = agent.identityEmoji || (agent.id === 'main' ? '\u2699\uFE0F' : '\uD83E\uDD16');

  return (
    <article className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-start gap-3">
        <div
          aria-hidden
          data-testid={`agent-emoji-${agent.id}`}
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-base"
        >
          {displayEmoji}
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{agent.name ?? agent.id}</h2>
            {agent.isDefault && (
              <span className="text-xs font-medium text-primary">{t('card.default')}</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{agent.id}</p>
          <p className="text-sm">{agent.model ?? t('card.modelFallback')}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-label={`Edit ${agent.id}`}
          disabled={locked}
          onClick={onEdit}
        >
          {t('card.actions.edit')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Delete ${agent.id}`}
          disabled={locked}
          onClick={onDelete}
        >
          {t('card.actions.delete')}
        </Button>
        <Button
          size="sm"
          aria-label={`Manage ${agent.id}`}
          disabled={locked}
          onClick={onManage}
        >
          {t('card.actions.manage')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Chat ${agent.id}`}
          onClick={onChat}
        >
          {t('card.actions.chat')}
        </Button>
      </div>
    </article>
  );
}

export default SubagentCard;
