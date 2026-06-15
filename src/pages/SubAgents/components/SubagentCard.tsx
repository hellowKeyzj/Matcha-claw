import { AgentAvatar } from '@/components/common/AgentAvatar';
import { Button } from '@/components/ui/button';
import type { SubagentSummary } from '@/types/subagent';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';

interface SubagentCardProps {
  agent: SubagentSummary;
  modelLabel?: string;
  editLocked?: boolean;
  deleteLocked?: boolean;
  manageLocked?: boolean;
  exportLocked?: boolean;
  modelReady?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onExport: () => void;
  onManage: () => void;
  onChat: () => void;
}

export function SubagentCard({
  agent,
  modelLabel,
  editLocked = false,
  deleteLocked = false,
  manageLocked = false,
  exportLocked = false,
  modelReady = true,
  onEdit,
  onDelete,
  onExport,
  onManage,
  onChat,
}: SubagentCardProps) {
  const { t } = useTranslation('subagents');
  const chatDisabled = !modelReady;

  return (
    <article className="rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <AgentAvatar
            avatarSeed={agent.avatarSeed}
            avatarStyle={agent.avatarStyle}
            agentId={agent.id}
            agentName={agent.name}
            className="mt-0.5 h-8 w-8 shrink-0"
            dataTestId={`agent-avatar-${agent.id}`}
          />
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold">{agent.name ?? agent.id}</h2>
              {agent.isDefault && (
                <span className="shrink-0 text-xs font-medium text-primary">{t('card.default')}</span>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">{agent.id}</p>
            <p className="truncate text-sm">{modelLabel ?? t('card.modelFallback')}</p>
          </div>
        </div>
        <Button
          size="icon"
          variant="outline"
          className="h-8 w-8 shrink-0"
          aria-label={`Export ${agent.id}`}
          title={t('card.actions.export')}
          disabled={exportLocked}
          onClick={onExport}
        >
          <Download className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-label={`Edit ${agent.id}`}
          disabled={editLocked}
          onClick={onEdit}
        >
          {t('card.actions.edit')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Delete ${agent.id}`}
          disabled={deleteLocked}
          onClick={onDelete}
        >
          {t('card.actions.delete')}
        </Button>
        <Button
          size="sm"
          aria-label={`Manage ${agent.id}`}
          disabled={manageLocked}
          onClick={onManage}
        >
          {t('card.actions.manage')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Chat ${agent.id}`}
          disabled={chatDisabled}
          title={chatDisabled ? t('card.modelMissingHint') : undefined}
          onClick={onChat}
        >
          {t('card.actions.chat')}
        </Button>
      </div>
    </article>
  );
}

export default SubagentCard;
