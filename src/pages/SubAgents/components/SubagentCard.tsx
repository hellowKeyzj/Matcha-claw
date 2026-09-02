import { AgentAvatar } from '@/components/common/AgentAvatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SubagentSummary } from '@/types/subagent';
import { Download, MessageCircle, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SubagentCardProps {
  agent: SubagentSummary;
  modelLabel?: string;
  editLocked?: boolean;
  deleteLocked?: boolean;
  exportLocked?: boolean;
  modelReady?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onExport: () => void;
  onChat: () => void;
}

export function SubagentCard({
  agent,
  modelLabel,
  editLocked = false,
  deleteLocked = false,
  exportLocked = false,
  modelReady = true,
  onEdit,
  onDelete,
  onExport,
  onChat,
}: SubagentCardProps) {
  const { t } = useTranslation('subagents');
  const chatDisabled = !modelReady;
  const displayName = agent.name ?? agent.id;
  const description = agent.description?.trim();

  return (
    <article className="group relative overflow-hidden rounded-2xl border bg-card/90 p-4 text-card-foreground shadow-sm transition-colors hover:border-primary/30 hover:bg-card">
      <div className="absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-primary/8 to-transparent" aria-hidden="true" />
      <div className="relative flex items-center justify-between">
        <span className="max-w-[60%] truncate rounded-full border bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
          {modelLabel ?? t('card.modelFallback')}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground"
              aria-label={`${t('card.actions.more')} ${agent.id}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-36">
            <DropdownMenuItem disabled={exportLocked} onSelect={onExport}>
              <Download className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{t('card.actions.export')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={editLocked} onSelect={onEdit}>
              <Pencil className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{t('card.actions.edit')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={deleteLocked}
              title={deleteLocked ? t('card.lockedHint') : undefined}
              className="text-destructive data-[highlighted]:text-destructive"
              onSelect={onDelete}
            >
              <Trash2 className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{t('card.actions.delete')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="relative mt-4 flex flex-col items-center text-center">
        <div className="rounded-3xl border bg-background p-1.5 shadow-sm">
          <AgentAvatar
            avatarSeed={agent.avatarSeed}
            avatarStyle={agent.avatarStyle}
            agentId={agent.id}
            agentName={agent.name}
            className="h-14 w-14"
            dataTestId={`agent-avatar-${agent.id}`}
          />
        </div>
        <div className="mt-3 flex max-w-full items-center gap-2">
          <h2 className="truncate text-base font-semibold">{displayName}</h2>
          {agent.isDefault && (
            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              {t('card.default')}
            </span>
          )}
        </div>
        {description ? (
          <p className="mt-2 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>

      <div className="relative mt-4">
        <Button
          size="sm"
          className="w-full gap-1.5"
          aria-label={`Chat ${agent.id}`}
          disabled={chatDisabled}
          title={chatDisabled ? t('card.modelMissingHint') : undefined}
          onClick={onChat}
        >
          <MessageCircle className="h-3.5 w-3.5" />
          {t('card.actions.chat')}
        </Button>
      </div>
    </article>
  );
}

export default SubagentCard;
