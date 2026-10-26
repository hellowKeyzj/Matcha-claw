import { useLayoutStore } from '@/stores/layout';
import { ChatWorkspaceHost } from './ChatWorkspaceHost';

export default function ChatPage() {
  const takeoverMode = useLayoutStore((state) => state.chatTakeoverMode);
  return <ChatWorkspaceHost takeoverMode={takeoverMode} />;
}
