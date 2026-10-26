import { Fragment, memo, Suspense, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Plus, ShieldCheck } from 'lucide-react';
import { useContributions } from '@/plugin-host/react';
import { chatComposerActions, type ChatComposerAction, type ChatComposerActionState } from '../extensions';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionRunPhase } from '@/types/session/runtime-state';
import type { PermissionPickerState } from '@/plugins/chat/useChatPermissions';
import type { ChatContextUsageViewModel } from '@/plugins/chat/context-usage';
import { ChatModelPicker, type ModelPickerState } from '@/plugins/chat/components/ChatModelPicker';

interface ChatInputToolbarProps {
  composerAnchorName: string;
  sessionIdentity: SessionIdentity | null;
  scopeKey: string;
  activeRunId: string | null;
  runPhase: SessionRunPhase | null;
  disabled: boolean;
  sending: boolean;
  approvalWaiting: boolean;
  permissionPicker: PermissionPickerState | null;
  permissionPickerOpen: boolean;
  permissionPickerDisabled: boolean;
  onPermissionPickerOpenChange: (open: boolean) => void;
  goalSupported: boolean;
  goalDisabled: boolean;
  onStartGoal: () => void;
  skillManagerLabel: string | undefined;
  skillManagerOpen: boolean;
  onOpenSkillManager: () => void;
  modelPicker: ModelPickerState | null;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  quickPhraseOpen: boolean;
  onToggleQuickPhrase: () => void;
  onAttachFiles: () => Promise<void>;
}

export const ChatInputToolbar = memo(function ChatInputToolbar({
  composerAnchorName, sessionIdentity, scopeKey, activeRunId, runPhase, disabled, sending, approvalWaiting,
  permissionPicker, permissionPickerOpen, permissionPickerDisabled, onPermissionPickerOpenChange,
  goalSupported, goalDisabled, onStartGoal, skillManagerLabel, skillManagerOpen, onOpenSkillManager,
  modelPicker, modelPickerOpen, onModelPickerOpenChange, quickPhraseOpen, onToggleQuickPhrase, onAttachFiles,
}: ChatInputToolbarProps) {
  const { t } = useTranslation('chat');
  const contributions = useContributions(chatComposerActions);
  const actions = useMemo(() => [...contributions].sort((left, right) => left.order - right.order), [contributions]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<string | null>(null);
  const menuActionRef = useRef<ChatComposerAction | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const context: ChatComposerActionState = {
    t, sessionIdentity, disabled, actionsDisabled: disabled || sending || approvalWaiting,
    goalSupported, goalDisabled, skillManagerLabel, skillManagerOpen, quickPhraseOpen,
  };
  const closePanel = (open: boolean) => {
    if (!open) setPanel(null);
  };

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={(open) => {
        setMenuOpen(open);
        if (open) {
          setPanel(null);
          onPermissionPickerOpenChange(false);
          onModelPickerOpenChange(false);
        }
      }}>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} type="button" variant="ghost" size="icon" className="chat-more-trigger h-9 w-9 shrink-0"
            data-chat-control="more" aria-label={t('input.moreActions')} title={t('input.moreActions')}>
            <Plus aria-hidden="true" className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[calc(100vw-24px)] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            const action = menuActionRef.current;
            menuActionRef.current = null;
            if (!action) return;
            event.preventDefault();
            // Open only after the menu's focus scope has closed.
            void action.execute({
              ...context,
              attachFiles: () => { triggerRef.current?.focus(); return onAttachFiles(); },
              openPanel: setPanel, toggleQuickPhrase: onToggleQuickPhrase,
              openSkillManager: onOpenSkillManager, startGoal: onStartGoal,
            });
          }}>
          {actions.map((action) => {
            const state = action.resolve(context);
            if (state.hidden) return null;
            const Icon = action.icon;
            return <Fragment key={action.id}>
              <DropdownMenuItem data-testid={action.testId} data-chat-control={action.control} disabled={state.disabled}
                aria-haspopup={state.dialogExpanded === undefined ? undefined : 'dialog'} aria-expanded={state.dialogExpanded}
                onSelect={() => { menuActionRef.current = action; }}>
                <Icon aria-hidden="true" className="h-4 w-4" />{state.label}
              </DropdownMenuItem>
              {action.separatorAfter ? <DropdownMenuSeparator /> : null}
            </Fragment>;
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {permissionPicker ? (
        <DropdownMenu open={permissionPickerOpen} onOpenChange={onPermissionPickerOpenChange}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" disabled={permissionPickerDisabled}
              data-testid="chat-permission-picker" data-chat-control="permission"
              aria-label={[t('input.pickPermissionMode'), permissionPicker.label, permissionPicker.status].filter(Boolean).join(' · ')}
              title={[t('input.permissionPickerTitle'), permissionPicker.label, permissionPicker.status].filter(Boolean).join(' · ')}
              className={cn('chat-permission-trigger h-9 w-9 shrink-0 disabled:pointer-events-auto',
                permissionPicker.tone === 'positive' && 'text-emerald-700 dark:text-emerald-300',
                permissionPicker.tone === 'warning' && 'text-amber-700 dark:text-amber-300')}>
              {permissionPicker.busy ? <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" /> : <ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-72 max-w-[calc(100vw-24px)] overflow-y-auto">
            {permissionPicker.status ? <p role="status" className="px-2.5 py-2 text-xs text-muted-foreground">{permissionPicker.status}</p> : null}
            {permissionPicker.options.map((option) => (
              <DropdownMenuItem key={option.id} role="menuitemradio" aria-checked={option.id === permissionPicker.currentId}
                disabled={permissionPickerDisabled || option.disabled} title={option.disabledReason ?? option.label}
                onSelect={() => { if (option.id !== permissionPicker.currentId) permissionPicker.onSelect(option.id); }}>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{option.label}</span><span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{option.description}</span></span>
                {option.id === permissionPicker.currentId ? <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {modelPicker ? <ChatModelPicker state={modelPicker} open={modelPickerOpen} onOpenChange={onModelPickerOpenChange} scopeKey={scopeKey} composerAnchorName={composerAnchorName} /> : <span className="min-w-0 flex-1" />}
      {actions.map(({ id, panel: Panel }) => Panel ? (
        <Suspense key={id} fallback={null}>
          <Panel sessionIdentity={sessionIdentity} activeRunId={activeRunId} runPhase={runPhase}
            open={panel === id} onOpenChange={closePanel} returnFocusRef={triggerRef} />
        </Suspense>
      ) : null)}
    </>
  );
});

export const ChatInputStatus = memo(function ChatInputStatus({ contextUsage, imageGenerationActive }: {
  contextUsage: ChatContextUsageViewModel | null;
  imageGenerationActive: boolean;
}) {
  const { t } = useTranslation('chat');
  if (!contextUsage && !imageGenerationActive) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 pb-1 text-[11px] text-muted-foreground">
      {imageGenerationActive ? <div data-testid="chat-composer-image-generation-indicator" role="status" aria-live="polite" className="inline-flex min-w-0 items-center gap-1.5">
        <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" /><span>{t('input.imageGenerationActive')}</span>
      </div> : null}
      {contextUsage ? <span role="status" title={t('input.contextUsageTitle', { detail: contextUsage.detail, pct: contextUsage.pct })}
        aria-label={t('input.contextUsageTitle', { detail: contextUsage.detail, pct: contextUsage.pct })}
        className={cn('min-w-0', contextUsage.level === 'danger' ? 'text-destructive' : contextUsage.level === 'warning' ? 'text-amber-700 dark:text-amber-300' : '')}>
        {t('input.contextUsageLabel', { pct: contextUsage.pct })}
      </span> : null}
    </div>
  );
});
