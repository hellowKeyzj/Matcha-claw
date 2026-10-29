import { useLayoutStore } from '@/app/layout/store';
import { ChatWorkspaceHost } from './ChatWorkspaceHost';

export default function ChatPage() {
  const viewportTakeover = useLayoutStore((state) => state.viewportTakeover);
  return <ChatWorkspaceHost takeoverMode={viewportTakeover ? 'artifact-workbench' : 'none'} />;
}
