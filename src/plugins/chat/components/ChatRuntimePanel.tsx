import { useTranslation } from 'react-i18next';
import type { ChatPanelProps } from '../extensions';

export function ChatRuntimePanel(props: ChatPanelProps) {
  const { t } = useTranslation('chat');
  return props.content
    ? <div key={props.content.key} className="flex min-h-0 flex-1 flex-col overflow-hidden">{props.content.render(props)}</div>
    : <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">{t('board.runtimeEmpty', { defaultValue: 'Open a Browser Tab, MCP App, or Canvas from a tool card to preview it here.' })}</div>;
}
