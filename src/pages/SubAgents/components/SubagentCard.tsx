import { AgentAvatar } from '@/components/common/AgentAvatar';
import { AgentResourceCard, AgentResourceFooter, AgentResourcePill } from '@/components/common/AgentPage';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { SubagentSummary } from '@/types/subagent';
import { CloudUpload, Download, Lock, MessageCircle, MoreHorizontal, Package, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SubagentCardProps {
  agent: SubagentSummary;
  modelLabel?: string;
  compact?: boolean;
  editLocked?: boolean;
  deleteLocked?: boolean;
  exportLocked?: boolean;
  packageExportLocked?: boolean;
  modelReady?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onExport: () => void;
  onExportPackage: () => void;
  onUploadPackageToCloud: () => void;
  onOpenCloudPackages: () => void;
  onChat: () => void;
}

export function SubagentCard({
  agent,
  modelLabel,
  compact = false,
  editLocked = false,
  deleteLocked = false,
  exportLocked = false,
  packageExportLocked = false,
  modelReady = true,
  onEdit,
  onDelete,
  onExport,
  onExportPackage,
  onUploadPackageToCloud,
  onOpenCloudPackages,
  onChat,
}: SubagentCardProps) {
  const { t } = useTranslation('subagents');
  const chatDisabled = !modelReady;
  const displayName = agent.name ?? agent.id;
  const description = agent.description?.trim();
  const badges = (
    <>
      {agent.isDefault && (
        <AgentResourcePill>{t('card.default')}</AgentResourcePill>
      )}
      {agent.sealed && (
        <AgentResourcePill>
          <Lock className="h-3 w-3" />
          {t('card.sealed')}
        </AgentResourcePill>
      )}
      {!agent.sealed && !agent.isDefault && agent.kind !== 'system' && (
        <AgentResourcePill>
          <Package className="h-3 w-3" />
          {t('card.package')}
        </AgentResourcePill>
      )}
    </>
  );
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn('shrink-0 rounded-full text-muted-foreground hover:text-foreground', compact ? 'h-8 w-8' : 'h-7 w-7')}
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
        <DropdownMenuItem disabled={packageExportLocked} onSelect={onExportPackage}>
          <Package className="h-4 w-4" />
          <span className="min-w-0 flex-1 truncate">{t('card.actions.exportPackage')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={packageExportLocked} onSelect={onUploadPackageToCloud}>
          <CloudUpload className="h-4 w-4" />
          <span className="min-w-0 flex-1 truncate">{t('card.actions.uploadPackageToCloud')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenCloudPackages}>
          <Download className="h-4 w-4" />
          <span className="min-w-0 flex-1 truncate">{t('card.actions.cloudPackages')}</span>
        </DropdownMenuItem>
        {compact && (
          <DropdownMenuItem disabled={editLocked} onSelect={onEdit}>
            <Pencil className="h-4 w-4" />
            <span className="min-w-0 flex-1 truncate">{t('card.actions.edit')}</span>
          </DropdownMenuItem>
        )}
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
  );
  const identity = (
    <div className="flex min-w-0 items-center gap-3">
      <AgentAvatar
        avatarSeed={agent.avatarSeed}
        avatarStyle={agent.avatarStyle}
        agentId={agent.id}
        agentName={agent.name}
        className="h-11 w-11 shrink-0 rounded-2xl border border-border/70 shadow-sm ring-1 ring-background/70"
        dataTestId={`agent-avatar-${agent.id}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="min-w-0 truncate text-sm font-semibold" title={displayName}>{displayName}</h2>
          {compact && <span className="inline-flex gap-1 text-muted-foreground">{badges}</span>}
          {compact && agent.kind === 'system' && <span className="text-xs text-muted-foreground">{t('card.system')}</span>}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={agent.id}>{agent.id}</p>
      </div>
      {!compact && menu}
    </div>
  );
  const model = (
    <AgentResourcePill className="min-w-0">
      <span className="truncate" title={modelLabel ?? t('card.modelFallback')}>{modelLabel ?? t('card.modelFallback')}</span>
    </AgentResourcePill>
  );
  const chat = (
    <Button
      size="sm"
      variant="ghost"
      className="h-8 shrink-0 gap-1.5 px-2"
      aria-label={`${t('card.actions.chat')} ${agent.id}`}
      disabled={chatDisabled}
      title={chatDisabled ? t('card.modelMissingHint') : undefined}
      onClick={onChat}
    >
      <MessageCircle className="h-3.5 w-3.5" />
      {t('card.actions.chat')}
    </Button>
  );

  if (compact) {
    return (
      <AgentResourceCard className="gap-3 p-4 lg:flex-row lg:items-center lg:gap-7">
        <div className="min-w-0 flex-1">
          {identity}
          {description && <p className="mt-1 truncate pl-[52px] text-xs text-muted-foreground" title={description}>{description}</p>}
        </div>
        <div className="flex min-w-0 items-center gap-4 pl-[52px] lg:shrink-0 lg:gap-6 lg:pl-0">
          <div className="min-w-0 flex-1 lg:w-60 lg:flex-none">{model}</div>
          <div className="flex shrink-0 items-center gap-1">{chat}{menu}</div>
        </div>
      </AgentResourceCard>
    );
  }

  return (
    <AgentResourceCard className="gap-4 p-4">
      <div className="min-w-0">
        {identity}
        {description && <p className="mt-4 line-clamp-2 text-sm leading-5 text-muted-foreground">{description}</p>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">{badges}{model}</div>
      <AgentResourceFooter className="py-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-8 shrink-0 gap-1.5 px-2"
          aria-label={`${t('card.actions.edit')} ${agent.id}`}
          disabled={editLocked}
          title={editLocked ? t('card.lockedHint') : undefined}
          onClick={onEdit}
        >
          <Pencil className="h-3.5 w-3.5" />
          {t('card.actions.edit')}
        </Button>
        {agent.kind === 'system' && <span className="mr-auto">{t('card.system')}</span>}
        {chat}
      </AgentResourceFooter>
    </AgentResourceCard>
  );
}

export default SubagentCard;
