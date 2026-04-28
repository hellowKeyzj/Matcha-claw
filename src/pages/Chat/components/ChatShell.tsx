import type { ComponentProps, ReactNode, RefObject } from 'react';
import { VerticalPaneResizer } from '@/components/layout/VerticalPaneResizer';
import { cn } from '@/lib/utils';
import { TaskInboxPanel } from './TaskInboxPanel';

interface ChatShellProps {
  chatLayoutRef: RefObject<HTMLDivElement | null>;
  taskInboxCollapsed: boolean;
  taskInboxWidth: number;
  taskInboxResizerWidth: number;
  onTaskInboxResizeStart: ComponentProps<typeof VerticalPaneResizer>['onMouseDown'];
  onToggleTaskInbox: () => void;
  stagePanel: ReactNode;
}

export function ChatShell({
  chatLayoutRef,
  taskInboxCollapsed,
  taskInboxWidth,
  taskInboxResizerWidth,
  onTaskInboxResizeStart,
  onToggleTaskInbox,
  stagePanel,
}: ChatShellProps) {
  return (
    <div
      ref={chatLayoutRef}
      className={cn(
        'grid h-full min-h-0 overflow-hidden bg-[linear-gradient(180deg,rgba(248,250,252,0.7),rgba(244,245,247,0.42))] [grid-template-columns:minmax(0,1fr)_var(--task-inbox-resizer-width)_var(--task-inbox-width)] dark:bg-[linear-gradient(180deg,rgba(24,24,27,0.42),rgba(18,18,20,0.24))]',
        taskInboxCollapsed ? '[grid-template-columns:minmax(0,1fr)_52px]' : '',
      )}
      style={{
        ['--task-inbox-width' as string]: `${taskInboxWidth}px`,
        ['--task-inbox-resizer-width' as string]: `${taskInboxResizerWidth}px`,
      }}
    >
      {stagePanel}

      {!taskInboxCollapsed && (
        <VerticalPaneResizer
          testId="chat-right-resizer"
          className="block"
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
