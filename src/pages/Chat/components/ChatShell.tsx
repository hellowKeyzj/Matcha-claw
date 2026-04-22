import type { ComponentProps, RefObject } from 'react';
import { VerticalPaneResizer } from '@/components/layout/VerticalPaneResizer';
import { cn } from '@/lib/utils';
import { ChatInput } from '../ChatInput';
import { TaskInboxPanel } from './TaskInboxPanel';
import { AgentSkillConfigDialog } from './AgentSkillConfigDialog';
import { ChatList } from './ChatList';
import { ChatHeaderBar } from './ChatHeaderBar';
import { ChatApprovalDock, ChatErrorBanner } from './ChatRuntimeDock';

interface ChatShellProps {
  chatLayoutRef: RefObject<HTMLDivElement | null>;
  taskInboxCollapsed: boolean;
  taskInboxWidth: number;
  taskInboxResizerWidth: number;
  onTaskInboxResizeStart: ComponentProps<typeof VerticalPaneResizer>['onMouseDown'];
  onToggleTaskInbox: () => void;
  headerProps: ComponentProps<typeof ChatHeaderBar>;
  listProps: ComponentProps<typeof ChatList>;
  errorBannerProps: ComponentProps<typeof ChatErrorBanner> | null;
  approvalDockProps: ComponentProps<typeof ChatApprovalDock> | null;
  inputProps: ComponentProps<typeof ChatInput>;
  skillDialogProps: ComponentProps<typeof AgentSkillConfigDialog>;
}

export function ChatShell({
  chatLayoutRef,
  taskInboxCollapsed,
  taskInboxWidth,
  taskInboxResizerWidth,
  onTaskInboxResizeStart,
  onToggleTaskInbox,
  headerProps,
  listProps,
  errorBannerProps,
  approvalDockProps,
  inputProps,
  skillDialogProps,
}: ChatShellProps) {
  return (
    <div
      ref={chatLayoutRef}
      className={cn(
        'grid h-full min-h-0 grid-cols-1 overflow-hidden xl:[grid-template-columns:minmax(0,1fr)_var(--task-inbox-resizer-width)_var(--task-inbox-width)]',
        taskInboxCollapsed ? 'xl:[grid-template-columns:minmax(0,1fr)_52px]' : '',
      )}
      style={{
        ['--task-inbox-width' as string]: `${taskInboxWidth}px`,
        ['--task-inbox-resizer-width' as string]: `${taskInboxResizerWidth}px`,
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card">
        <ChatHeaderBar {...headerProps} />

        <ChatList {...listProps} />

        {errorBannerProps && (
          <ChatErrorBanner {...errorBannerProps} />
        )}

        {approvalDockProps && (
          <ChatApprovalDock {...approvalDockProps} />
        )}

        <ChatInput {...inputProps} />

        <AgentSkillConfigDialog {...skillDialogProps} />
      </div>

      {!taskInboxCollapsed && (
        <VerticalPaneResizer
          testId="chat-right-resizer"
          className="hidden xl:block"
          onMouseDown={onTaskInboxResizeStart}
          ariaLabel="Resize task inbox"
          variant="subtle-border"
        />
      )}

      <TaskInboxPanel
        collapsed={taskInboxCollapsed}
        onToggleCollapse={onToggleTaskInbox}
      />
    </div>
  );
}
