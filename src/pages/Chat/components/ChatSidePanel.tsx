import { memo, type CSSProperties } from 'react';
import { AlertCircle, ListTodo, RefreshCw, Settings2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import type { ChatSidePanelMode } from '../chat-workspace-layout';
import type { ChatSidePanelTab } from '../useChatSidePanelController';
import { AgentSkillConfigPanel, type AgentSkillOption } from './AgentSkillConfigPanel';

interface ChatSidePanelProps {
  mode: Exclude<ChatSidePanelMode, 'hidden'>;
  width: number;
  activeTab: ChatSidePanelTab;
  onTabChange: (tab: ChatSidePanelTab) => void;
  onClose: () => void;
  unfinishedTaskCount: number;
  skillConfigLabel: string;
  skillConfigTitle: string;
  skillOptions: AgentSkillOption[];
  skillsLoading: boolean;
  selectedSkillIds: string[];
  onToggleSkill: (skillId: string, checked: boolean) => void;
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'success' {
  if (status === 'in_progress') {
    return 'default';
  }
  if (status === 'pending') {
    return 'secondary';
  }
  if (status === 'completed') {
    return 'success';
  }
  return 'destructive';
}

function statusToPercent(status: string): number {
  if (status === 'completed') {
    return 100;
  }
  if (status === 'in_progress') {
    return 50;
  }
  return 0;
}

export const ChatSidePanel = memo(function ChatSidePanel({
  mode,
  width,
  activeTab,
  onTabChange,
  onClose,
  unfinishedTaskCount,
  skillConfigLabel,
  skillConfigTitle,
  skillOptions,
  skillsLoading,
  selectedSkillIds,
  onToggleSkill,
}: ChatSidePanelProps) {
  const { t } = useTranslation('chat');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const isGatewayRunning = gatewayStatus.state === 'running';
  const tasks = useTaskInboxStore((state) => state.tasks);
  const loading = useTaskInboxStore((state) => state.loading);
  const initialized = useTaskInboxStore((state) => state.initialized);
  const error = useTaskInboxStore((state) => state.error);
  const refreshTasks = useTaskInboxStore((state) => state.refreshTasks);
  const openTaskSession = useTaskInboxStore((state) => state.openTaskSession);
  const clearError = useTaskInboxStore((state) => state.clearError);
  const panelStyle = {
    ['--chat-side-panel-width' as string]: `${width}px`,
  } as CSSProperties;

  const handleOpenSession = (taskId: string) => {
    const result = openTaskSession(taskId);
    if (result.switched) {
      return;
    }
    toast.error(t('taskInbox.taskNotFound'));
  };

  return (
    <aside
      data-testid="chat-side-panel"
      data-mode={mode}
      data-active-tab={activeTab}
      className={cn(
        'relative flex h-full min-h-0 flex-col overflow-hidden bg-background',
        mode === 'docked'
          ? 'border-l [border-left-color:var(--divider-line)]'
          : 'rounded-[18px] border border-border/60 shadow-[0_24px_60px_rgba(15,23,42,0.18)]',
      )}
      style={panelStyle}
    >
      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange(value as ChatSidePanelTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="border-b border-border/40 bg-background/95 px-3 py-2">
          <div className="flex items-center gap-2">
            <TabsList className="grid h-auto flex-1 grid-cols-2 rounded-none border-0 bg-transparent p-0 text-foreground shadow-none">
              <TabsTrigger
                value="tasks"
                className="h-8 justify-start gap-2 rounded-md border border-transparent px-3 text-xs data-[state=active]:border-border/70 data-[state=active]:bg-muted/55 data-[state=active]:shadow-none"
              >
                <ListTodo className="h-3.5 w-3.5" />
                {t('taskInbox.title')}
              </TabsTrigger>
              <TabsTrigger
                value="skills"
                className="h-8 justify-start gap-2 rounded-md border border-transparent px-3 text-xs data-[state=active]:border-border/70 data-[state=active]:bg-muted/55 data-[state=active]:shadow-none"
              >
                <Settings2 className="h-3.5 w-3.5" />
                {skillConfigLabel}
              </TabsTrigger>
            </TabsList>
            {activeTab === 'tasks' ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-md border border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted/60 hover:text-foreground"
                onClick={() => void refreshTasks()}
                disabled={!isGatewayRunning || loading}
                title={t('taskInbox.refresh')}
              >
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('taskInbox.collapse')}
              className="h-8 w-8 rounded-md border border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-muted/60 hover:text-foreground"
              onClick={onClose}
              title={t('taskInbox.collapse')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <TabsContent value="tasks" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col">
          <div className="border-b border-border/40 px-4 py-3">
            <p className="text-sm font-medium text-foreground">{t('taskInbox.title')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('taskInbox.unfinishedCount', { count: unfinishedTaskCount })}
            </p>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {!isGatewayRunning ? (
              <div className="rounded-lg border border-yellow-400/45 bg-yellow-50/72 px-3 py-2 text-xs text-yellow-800 dark:border-yellow-700/60 dark:bg-yellow-950/20 dark:text-yellow-200">
                {t('taskInbox.gatewayStopped')}
              </div>
            ) : null}

            {error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="break-words">{error}</p>
                    <button
                      type="button"
                      onClick={clearError}
                      className="mt-1 text-[11px] underline underline-offset-2 hover:opacity-80"
                    >
                      {t('common:actions.dismiss')}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {!loading && initialized && tasks.length === 0 ? (
              <p className="rounded-lg border border-border/60 bg-muted/25 px-3 py-8 text-center text-sm text-muted-foreground">
                {t('taskInbox.empty')}
              </p>
            ) : null}

            {tasks.map((task) => {
              return (
                <Card key={`${task.id}-${task.workspaceDir || 'default'}`} className="border-border/60 bg-background shadow-none">
                  <CardContent className="space-y-3 p-3">
                    <button
                      type="button"
                      onClick={() => handleOpenSession(task.id)}
                      className="w-full space-y-3 rounded-md p-1 text-left transition-colors hover:bg-muted/40"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-sm font-medium">{task.subject || t('taskInbox.untitledTask')}</p>
                          <p className="mt-1 truncate text-[11px] text-muted-foreground">{task.id}</p>
                        </div>
                        <Badge variant={statusVariant(task.status)}>
                          {t(`taskInbox.status.${task.status}`, { defaultValue: task.status })}
                        </Badge>
                      </div>

                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">{statusToPercent(task.status)}%</p>
                      </div>
                    </button>

                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full rounded-md border-border/60 bg-background shadow-none hover:bg-muted/35"
                      onClick={() => handleOpenSession(task.id)}
                    >
                      {t('taskInbox.openSession')}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="skills" className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col">
          <AgentSkillConfigPanel
            title={skillConfigTitle}
            skillOptions={skillOptions}
            skillsLoading={skillsLoading}
            selectedSkillIds={selectedSkillIds}
            onToggleSkill={onToggleSkill}
          />
        </TabsContent>
      </Tabs>
    </aside>
  );
});
