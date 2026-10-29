import { memo, Suspense, useMemo, type CSSProperties } from 'react';
import { PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useContributions } from '@/plugin-host/react';
import { chatSidePanels, type ChatPanelProps } from '../extensions';
import type { ChatSidePanelMode } from '@/app/layout/workspace';
import type { ChatSidePanelTab } from '../useChatSidePanelController';

export interface ChatSidePanelPresentation extends Omit<ChatPanelProps, 'sessionIdentity'> {
  mode: ChatSidePanelMode;
  activeTab: ChatSidePanelTab;
  artifactWorkbenchFullscreen: boolean;
  onTabChange: (tab: ChatSidePanelTab) => void;
  onToggleArtifactWorkbenchFullscreen: () => void;
}

export interface ChatSidePanelProps extends ChatSidePanelPresentation {
  sessionIdentity?: ChatPanelProps['sessionIdentity'];
}

export const ChatSidePanel = memo(function ChatSidePanel(props: ChatSidePanelProps) {
  const { mode, width, activeTab, artifactWorkbenchFullscreen, onTabChange, onClose } = props;
  const { t } = useTranslation('chat');
  const contributions = useContributions(chatSidePanels);
  const panels = useMemo(() => [...contributions].sort((left, right) => left.order - right.order), [contributions]);
  const compactTopTabs = Math.max(0, width - 24 - 8 - 32) / panels.length < 78;
  const panelStyle = { ['--chat-side-panel-width' as string]: `${width}px` } as CSSProperties;

  return (
    <aside
      data-testid="chat-side-panel"
      data-mode={mode}
      data-active-tab={activeTab}
      data-artifact-fullscreen={artifactWorkbenchFullscreen ? 'true' : 'false'}
      className={cn(
        'relative flex h-full min-h-0 flex-col overflow-hidden bg-card',
        artifactWorkbenchFullscreen
          ? 'border-0'
          : mode === 'docked'
          ? 'border-l [border-left-color:var(--divider-line)]'
          : 'rounded-[18px] border border-border/60 shadow-[0_24px_60px_rgba(15,23,42,0.18)]',
      )}
      style={panelStyle}
    >
      <Tabs value={activeTab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border/40 bg-card px-3 py-2">
          <div className="flex items-center gap-2">
            <TabsList data-compact={compactTopTabs ? 'true' : 'false'}
              style={{ gridTemplateColumns: `repeat(${panels.length}, minmax(0, 1fr))` }}
              className="grid h-8 min-h-0 flex-1 gap-1 overflow-visible rounded-none border-0 bg-transparent p-0 text-foreground shadow-none">
              {panels.map(({ id, label, defaultLabel, title, icon: Icon }) => (
                <TabsTrigger key={id} value={id} data-testid={`chat-side-panel-tab-${id}`}
                  title={t(title ?? label, { defaultValue: defaultLabel })} aria-label={t(title ?? label, { defaultValue: defaultLabel })}
                  className={cn(
                    'h-8 min-w-0 rounded-full border-0 bg-transparent text-xs font-medium text-muted-foreground !shadow-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:!ring-0 focus-visible:!ring-offset-0 data-[state=active]:bg-secondary data-[state=active]:text-foreground data-[state=active]:!shadow-none',
                    compactTopTabs ? 'justify-center gap-0 px-0' : 'justify-center gap-1.5 px-2.5',
                  )}>
                  <Icon className="h-3.5 w-3.5" />
                  {!compactTopTabs ? <span className="truncate">{t(label, { defaultValue: defaultLabel })}</span> : null}
                </TabsTrigger>
              ))}
            </TabsList>
            <Button variant="ghost" size="icon" aria-label={t('toolbar.closeSidePanel')}
              className="h-8 w-8 rounded-md border border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-secondary hover:text-foreground"
              onClick={onClose} title={t('toolbar.closeSidePanel')}>
              <PanelRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {panels.map(({ id, component: Content }) => (
          <TabsContent key={id} value={id} className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col">
            <Suspense fallback={null}><Content
              sessionIdentity={props.sessionIdentity}
              width={width}
              content={props.content}
              layout={props.layout}
              onLayoutChange={props.onLayoutChange}
              onClose={onClose}
              onSendMessage={props.onSendMessage}
              onOpenLink={props.onOpenLink}
            /></Suspense>
          </TabsContent>
        ))}
      </Tabs>
    </aside>
  );
});
